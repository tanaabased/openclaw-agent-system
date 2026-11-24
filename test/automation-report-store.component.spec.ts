import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';

import deliverAutomationReport, {
  reconcileAutomationReport,
} from '../agent/automations/automation-report-delivery.ts';
import AutomationReportStore, {
  reportLifetimeMs,
  type AutomationReportRecord,
} from '../agent/automations/automation-report-store.ts';
import AutomationService from '../agent/automations/automation-service.ts';
import registerAutomationReportHooks from '../core/automation-report-hook.ts';
import sqliteAgentFixture from './sqlite-agent-fixture.ts';
import { prepareAutomationReport } from '../agent/automations/automation-report.ts';

describe('agent/automation-report-store', () => {
  let root: string;
  let now: number;
  let store: AutomationReportStore;
  beforeEach(async () => {
    root = await mkdtemp('/tmp/automation-report-store-');
    now = Date.parse('2026-10-30T00:00:00Z');
    store = new AutomationReportStore(root, () => now);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function report(state: AutomationReportRecord['state']): AutomationReportRecord {
    const executionId = randomUUID();
    return {
      version: 1,
      executionId,
      state,
      hash: 'job',
      manifestDigest: 'manifest',
      target: { agentId: 'a', workspaceDir: root, scope: 'owner', sessionKey: 'agent:a:report' },
      input: prepareAutomationReport({
        id: 'job',
        executionId,
        startedAt: new Date(now).toISOString(),
        cancelled: false,
        result: {
          exitCode: 0,
          timedOut: false,
          truncated: false,
          output: { stdout: 'saved', stderr: '' },
        },
      }),
    };
  }
  async function save(record: AutomationReportRecord) {
    await store.withLock(record.executionId, () => store.write(record));
  }

  it('should reopen every legacy state without adding preferred presentation or replay', async () => {
    const records = ['pending', 'sending', 'submitted', 'uncertain', 'delivered', 'failed'].map(
      (state) => {
        const value = report(state as AutomationReportRecord['state']);
        delete value.input.presentation;
        return value;
      },
    );
    for (const record of records) await save(record);
    const reopened = new AutomationReportStore(root, () => now);
    for (const record of records) {
      const retained = await reopened.read(record.executionId);
      assert.equal(retained?.state, record.state);
      assert.equal(retained?.input.presentation, undefined);
    }
  });

  it('should preserve committed presentation when an expanded replacement exceeds storage budget', async () => {
    const record = report('pending');
    await save(record);
    const before = await store.read(record.executionId);
    await assert.rejects(
      store.update(record.executionId, (current) => {
        current.input.presentation = { kind: 'preferred', body: 'x'.repeat(256 * 1024) };
      }),
      /size limit/u,
    );
    assert.deepEqual(await store.read(record.executionId), before);
  });

  it('should recover only unresolved reports across reopen without rereading terminal history', async () => {
    const active = ['pending', 'sending', 'submitted', 'uncertain'].map((state) =>
      report(state as AutomationReportRecord['state']),
    );
    const complete = [report('delivered'), report('failed')];
    for (const record of [...active, ...complete]) await save(record);
    assert.deepEqual(
      new Set(await store.recoveryIds()),
      new Set(active.map((record) => record.executionId)),
    );
    await store.prune();
    store = new AutomationReportStore(root, () => now);
    const read = store.read.bind(store);
    store.read = async (id) => {
      assert.ok(
        !complete.some((record) => record.executionId === id),
        'routine recovery must not read terminal history',
      );
      return read(id);
    };
    assert.deepEqual(
      new Set(await store.recoveryIds()),
      new Set(active.map((record) => record.executionId)),
    );
    await store.prune();
    assert.equal((await store.ids()).length, active.length + complete.length);
  });

  it('should expire terminal history while retaining old unresolved custody and refusing replay', async () => {
    const complete = report('delivered');
    const uncertain = report('uncertain');
    await save(complete);
    await save(uncertain);
    await store.prune();
    now += reportLifetimeMs + 1;
    await store.prune();
    assert.deepEqual(await store.recoveryIds(), [uncertain.executionId]);
    assert.equal(await store.read(complete.executionId), undefined);
    assert.equal((await store.read(uncertain.executionId))?.state, 'uncertain');
    const replay = await deliverAutomationReport({
      store,
      target: complete.target,
      hash: complete.hash,
      manifestDigest: complete.manifestDigest,
      input: {
        id: complete.input.id,
        executionId: complete.executionId,
        startedAt: complete.input.startedAt,
        cancelled: false,
        result: { exitCode: 0, timedOut: false, truncated: false },
      },
      selectSettings: async () => {
        throw new Error('must not select');
      },
      assertCurrent: async () => {
        throw new Error('must not submit');
      },
    });
    assert.equal(replay.code, 'automation-report-expired');
    assert.equal(await store.read(complete.executionId), undefined);
  });

  it('should resume and prune reports in each sqlite agent database after restart', async () => {
    const { sqliteInstallation, storageBackend } = await sqliteAgentFixture(root, 'a');
    await sqliteAgentFixture(root, 'b');
    const service = new AutomationService({
      sqliteInstallation,
      storageBackend,
      root,
      profile: root,
      command: [],
      environment: {},
      now: () => now,
      manifestService: { loadForAgentId: async () => assert.fail('unexpected manifest lookup') },
    });
    const a = await service.reportStore('a');
    const b = await service.reportStore('b');
    const pending = report('submitted');
    const old = report('failed');
    await a.write(pending);
    await a.write(old);
    const other = {
      ...pending,
      target: { ...pending.target, agentId: 'b' },
      state: 'uncertain' as const,
    };
    await b.write(other);
    now += reportLifetimeMs + 1;
    const recent = report('delivered');
    await a.write(recent);

    const recovered: string[] = [];
    let tick!: () => Promise<void>;
    registerAutomationReportHooks(
      {
        on: (name: string, hook: () => Promise<void>) => {
          if (name === 'cron_reconciled') tick = hook;
        },
        logger: { warn: (warning: string) => assert.fail(warning) },
      } as never,
      new AutomationService(service.dependencies),
      async (selected, id) => {
        const retained = (await selected.read(id))!;
        recovered.push(retained.target.agentId + ':' + retained.state);
        await selected.update(id, (value) => {
          value.state = 'delivered';
        });
      },
    );
    await tick();
    await tick();
    assert.deepEqual(recovered.sort(), ['a:submitted', 'b:uncertain']);
    assert.deepEqual(new Set(await a.ids()), new Set([pending.executionId, recent.executionId]));
    assert.deepEqual(await b.ids(), [pending.executionId]);
    assert.equal(await a.read(old.executionId), undefined);
    assert.equal(await a.file(pending.executionId, true).read(), undefined);
  });

  it('should migrate legacy terminal records and prefer committed terminal evidence after interruption', async () => {
    const complete = report('delivered');
    await store.withLock(complete.executionId, () =>
      store.file(complete.executionId).write(JSON.stringify(complete)),
    );
    await reconcileAutomationReport({
      store,
      executionId: complete.executionId,
      selectSettings: async () => {
        throw new Error('terminal report must not select');
      },
      assertCurrent: async () => {
        throw new Error('terminal report must not be sent');
      },
      credential: {
        use: async () => {
          throw new Error('terminal report must not authenticate');
        },
      },
    });
    assert.deepEqual(await store.recoveryIds(), []);
    assert.equal(await store.file(complete.executionId).read(), undefined);
    assert.equal((await store.read(complete.executionId))?.state, 'delivered');
    await store.withLock(complete.executionId, () =>
      store.file(complete.executionId).write(JSON.stringify({ ...complete, state: 'pending' })),
    );
    assert.equal((await store.read(complete.executionId))?.state, 'delivered');
    await reconcileAutomationReport({
      store,
      executionId: complete.executionId,
      selectSettings: async () => {
        throw new Error('terminal report must not select');
      },
      assertCurrent: async () => {
        throw new Error('terminal report must not be sent');
      },
      credential: {
        use: async () => {
          throw new Error('terminal report must not authenticate');
        },
      },
    });
    assert.deepEqual(await store.recoveryIds(), []);
    assert.equal(await store.file(complete.executionId).read(), undefined);
    now += reportLifetimeMs + 1;
    await store.prune();
    assert.deepEqual(await store.recoveryIds(), []);
    assert.deepEqual(await store.ids(), []);
  });
});
