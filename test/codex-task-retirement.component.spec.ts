import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCodexIntake } from '../agent/codex-intake.ts';
import { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import reconcileCodexLifecycle from '../agent/tasks/dispatch/codex-assignment-lifecycle.ts';
import CodexDispatchStore, {
  type DispatchRecord,
} from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import codexDispatchFixture from './codex-dispatch-fixture.ts';

describe('agent/codex task-retirement', () => {
  const fixtureState = codexDispatchFixture();
  it('should retire old coordinator tasks through the current coordinator and retain native provenance', async () => {
    await fixtureState.writeCleanup(0);
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const original = structuredClone((await journal.read()).records[0]!);
    const find = fixtureState.deps.native!.find;
    fixtureState.deps.native!.find = async (input) => {
      assert.equal(input.sourceThreadId, original.sourceThreadId);
      assert.equal(input.prompt, original.request!.prompt);
      return find(input);
    };
    fixtureState.deps.activation = async () => ({ sourceThreadId: 'replacement-intake' });
    await assert.rejects(
      reconcileCodexLifecycle(fixtureState.pluginData, fixtureState.deps),
      /dispatch-intake-caller-required/,
    );
    fixtureState.deps.threadId = 'replacement-intake';
    fixtureState.fixture.item.state = 'closed';
    fixtureState.now += 60_001;
    await reconcileCodexLifecycle(fixtureState.pluginData, fixtureState.deps);
    const held = (await journal.read()).records[0]!;
    assert.equal(held.sourceThreadId, original.sourceThreadId);
    assert.equal(held.retirement?.reason, 'issue-closed');
    assert.equal(held.retirement?.code, 'retirement-native-work-unresolved');
    assert.equal(held.retirement?.archiveAttempt, undefined);
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnEnded = true;
    fixtureState.now += 60_001;
    const ready = await reconcileCodexLifecycle(fixtureState.pluginData, fixtureState.deps);
    assert.equal(ready?.status, 'retirement-inventory-required');
    const operator = { threadId: 'operator' };
    const preview = await fixtureState.request('retire', { id: prepared.id }, operator);
    assert.equal(preview.status, 'retire-available');
    const applied = await fixtureState.request(
      'retire',
      { id: prepared.id, digest: preview.digest },
      operator,
    );
    assert.equal(applied.status, 'retirement-inventory-required');
    assert.equal((await journal.read()).records[0]!.sourceThreadId, original.sourceThreadId);
  });

  it('should use configured automatic grace and ignore obsolete settings during operator retirement', async () => {
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const originalOpenClaw = process.env.OPENCLAW_CONFIG_PATH;
    process.env.XDG_CONFIG_HOME = fixtureState.root;
    process.env.OPENCLAW_CONFIG_PATH = join(fixtureState.root, 'openclaw.json');
    delete fixtureState.deps.readCleanupConfiguration;
    try {
      await writeFile(
        process.env.OPENCLAW_CONFIG_PATH,
        JSON.stringify({
          plugins: { entries: { 'agent-system': { config: { cleanup: { graceMinutes: 17 } } } } },
        }),
      );
      const prepared = await fixtureState.prepare();
      fixtureState.created();
      await fixtureState.request('reconcile', {
        id: prepared.id,
        receipt: { threadId: fixtureState.native!.id },
      });
      fixtureState.native!.status = 'idle';
      fixtureState.native!.turnEnded = true;
      const directory = join(fixtureState.root, 'tanaab', 'agent-system');
      const path = join(directory, 'config.yaml');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path, 'schema-version: 1\ncleanup: {grace-minutes: 0}', { mode: 0o600 });
      fixtureState.fixture.item.state = 'closed';
      fixtureState.now += 60_000;
      await fixtureState.next();
      const selected = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
      const journal = new CodexDispatchStore(
        selected.store.location.root,
        selected.store.location.scope,
      );
      const automatic = (await journal.read()).records[0]!;
      assert.equal(automatic.retirement!.eligibleAt, fixtureState.now + 17 * 60_000);
      assert.ok(automatic);
      await writeFile(path, 'invalid obsolete settings');
      const operator = { threadId: 'operator' };
      const preview = await fixtureState.request('retire', { id: prepared.id }, operator);
      const queued = await fixtureState.request(
        'retire',
        { id: prepared.id, digest: preview.digest },
        operator,
      );
      assert.equal(queued.status, 'retirement-inventory-required');
      const requestedAt = fixtureState.now;
      fixtureState.now += 60_000;
      await fixtureState.next();
      const manual = (await journal.read()).records[0]!;
      assert.equal(manual.retirement!.eligibleAt, requestedAt);
      assert.notEqual(manual.retirement?.code, 'retirement-configuration-invalid');
      assert.ok(manual);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      if (originalOpenClaw === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = originalOpenClaw;
    }
  });

  it('should hold broken codex cleanup sources and retain the repaired configured deadline across edits', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnEnded = true;
    fixtureState.fixture.item.state = 'closed';
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const record = async () => (await journal.read()).records[0]!;
    await fixtureState.writeCleanup(-1);
    fixtureState.now += 60_000;
    await fixtureState.next();
    assert.equal((await record()).retirement?.code, 'retirement-configuration-invalid');
    assert.equal((await record()).retirement?.deadlinePending, true);
    await rm(join(fixtureState.root, 'openclaw.json'));
    fixtureState.now += 60_000;
    await fixtureState.next();
    assert.equal((await record()).retirement?.code, 'retirement-configuration-unavailable');
    assert.ok(await record());
    await fixtureState.writeCleanup(17);
    fixtureState.now += 60_000;
    await fixtureState.next();
    const deadline = fixtureState.now + 17 * 60_000;
    assert.equal((await record()).retirement?.eligibleAt, deadline);
    await fixtureState.writeCleanup(0);
    fixtureState.now += 60_000;
    await fixtureState.next();
    assert.equal((await record()).retirement?.eligibleAt, deadline);
    assert.ok(await record());
    fixtureState.now = deadline;
    assert.equal((await fixtureState.next()).status, 'retirement-inventory-required');
    assert.equal((await record()).retirement?.archiveAttempt, undefined);
  });

  it('should keep zero grace codex protection and defer archival when disk policy changes at final verification', async () => {
    await fixtureState.writeCleanup(0);
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    fixtureState.fixture.item.state = 'closed';
    fixtureState.now += 60_000;
    await fixtureState.next();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const record = async () => (await journal.read()).records[0]!;
    const eligibleAt = fixtureState.now;
    assert.equal((await record()).retirement?.eligibleAt, eligibleAt);
    assert.equal((await record()).retirement?.code, 'retirement-native-work-unresolved');
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnEnded = true;
    fixtureState.deps.retirementNative = {
      worktreeUsers: async () => ['issue-thread', 'unowned'],
      archiveOutcome: async () => 'unverified',
    };
    const threads = {
      schemaVersion: 4,
      pinnedThreads: [{ id: 'issue-thread' }],
      unavailableHosts: [],
      unavailableSources: [],
    };
    fixtureState.now += 60_000;
    await fixtureState.request('next', { projects: fixtureState.projects, threads });
    assert.equal((await record()).retirement?.code, 'retirement-worktree-shared');
    assert.equal((await record()).retirement?.archiveAttempt, undefined);
    const deadline = (await record()).retirement!.eligibleAt;
    assert.equal(deadline, eligibleAt);
    fixtureState.deps.retirementNative = {
      worktreeUsers: async () => ['issue-thread'],
      archiveOutcome: async () => 'unverified',
    };
    const git = fixtureState.deps.git!;
    fixtureState.deps.git = async (path, args) => {
      const result = await git(path, args);
      if (args[0] === 'remote') await fixtureState.writeCleanup(17);
      return result;
    };
    fixtureState.now += 60_000;
    await fixtureState.request('next', { projects: fixtureState.projects, threads });
    assert.equal((await record()).retirement?.code, 'retirement-configuration-changed');
    assert.equal((await record()).retirement?.archiveAttempt, undefined);
    assert.ok(await record());
    fixtureState.deps.git = git;
    fixtureState.now += 60_000;
    assert.equal(
      (await fixtureState.request('next', { projects: fixtureState.projects, threads })).status,
      'retirement-prepared',
    );
    assert.equal((await record()).retirement?.eligibleAt, deadline);
    assert.ok(await record());
  });

  it('should enter manual retirement for open assigned work immediately and retain its request', async () => {
    const first = await fixtureState.prepare();
    const operator = {
      threadId: 'operator',
      activation: async (
        _data: unknown,
        _options: unknown,
        paused?: boolean,
        retained?: boolean,
      ) => {
        assert.equal(paused, false);
        assert.equal(retained, true);
        return { sourceThreadId: 'intake-thread' };
      },
    };
    await assert.rejects(
      fixtureState.request('retire', { id: first.id }),
      /dispatch-operator-caller-required/,
    );

    let connected = false;
    await assert.rejects(
      fixtureState.request(
        'retire',
        { id: first.id },
        {
          ...operator,
          native: {
            ...fixtureState.deps.native!,
            operatorInput: async () => {
              throw new Error('reply-native-user-input-required');
            },
          },
          connect: async (...args) => {
            connected = true;
            return fixtureState.deps.connect!(...args);
          },
        },
      ),
      /reply-native-user-input-required/,
    );
    assert.equal(connected, false);
    const before = (await fixtureState.readDispatchState()).records as Record<string, unknown>[];
    const preview = await fixtureState.request('retire', { id: first.id }, operator);
    assert.equal(preview.status, 'retire-available');
    assert.deepEqual((await fixtureState.readDispatchState()).records, before);
    await assert.rejects(
      fixtureState.request('retire', { id: first.id, digest: 'stale' }, operator),
      /dispatch-recovery-stale/,
    );
    const applied = await fixtureState.request(
      'retire',
      { id: first.id, digest: preview.digest },
      operator,
    );
    assert.equal(applied.status, 'retirement-pending');
    const after = (await fixtureState.readDispatchState()).records as Record<string, unknown>[];
    assert.ok(after[0]!);
    const disposition = after[0]!.retirement as {
      reason: string;
      eligibleAt: number;
      operatorRequest: { caller: string; targetId: string };
    };
    assert.equal(disposition.reason, 'operator-requested');
    assert.equal(disposition.eligibleAt, fixtureState.now);
    assert.equal(disposition.operatorRequest.caller, 'operator');
    assert.equal(disposition.operatorRequest.targetId, first.id);
    assert.equal(
      ((await fixtureState.request('inspect')).records as { workflowStatus: string }[])[0]!
        .workflowStatus,
      'retirement-pending',
    );
    assert.equal(after[0]!.lifecycleCheckedAt, fixtureState.now);
    assert.equal(fixtureState.fixture.item.state, 'open');
    fixtureState.now += 60_001;
    const repeated = await fixtureState.request('retire', { id: first.id }, operator);
    await fixtureState.request('retire', { id: first.id, digest: repeated.digest }, operator);
    const retirement = (
      (await fixtureState.readDispatchState()).records as Record<string, unknown>[]
    )[0]!.retirement as { eligibleAt: number };
    assert.equal(retirement.eligibleAt, (applied.retirement as { eligibleAt: number }).eligibleAt);
    await fixtureState.next();
    const reconciled = (
      (await fixtureState.readDispatchState()).records as Record<string, unknown>[]
    )[0]!;
    assert.equal(reconciled.lifecycleCheckedAt, fixtureState.now);
    assert.ok(reconciled);
    assert.equal(
      (reconciled.retirement as { code: string }).code,
      'retirement-native-creation-unresolved',
    );
    await assert.rejects(
      fixtureState.request('context', { id: first.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-retired/,
    );
  });

  it('should retain a self-retirement request without archiving the active caller', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnEnded = true;
    const caller = { threadId: 'issue-thread' };
    const preview = await fixtureState.request('retire', { id: prepared.id }, caller);
    const applied = await fixtureState.request(
      'retire',
      { id: prepared.id, digest: preview.digest },
      caller,
    );
    assert.equal(applied.status, 'retirement-pending');
    assert.equal(
      (applied.retirement as { code: string }).code,
      'retirement-native-work-unresolved',
    );
    assert.equal(fixtureState.fixture.item.state, 'open');
  });

  it('should allow verified operator retirement from another managed issue chat', async () => {
    const first = await fixtureState.prepare();
    fixtureState.fixture.item.state = 'closed';
    const operator = {
      threadId: 'operator',
      activation: async () => ({ sourceThreadId: 'intake-thread' }),
    };
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records.push({
        ...structuredClone(state.records[0]!),
        id: 'f'.repeat(64),
        issueKey: 'e'.repeat(64),
        threadId: 'operator',
        worktree: fixtureState.worktree,
      });
      await save();
    });
    const before = await fixtureState.readDispatchState();
    let connected = false;
    await assert.rejects(
      fixtureState.request(
        'retire',
        { id: first.id },
        {
          ...operator,
          native: {
            ...fixtureState.deps.native!,
            operatorInput: async () => {
              throw new Error('reply-native-user-input-required');
            },
          },
          connect: async (...args) => {
            connected = true;
            return fixtureState.deps.connect!(...args);
          },
        },
      ),
      /reply-native-user-input-required/,
    );
    assert.equal(connected, false);
    assert.deepEqual(await fixtureState.readDispatchState(), before);
    const preview = await fixtureState.request('retire', { id: first.id }, operator);
    assert.equal(preview.status, 'retire-available');
    assert.equal(
      (await fixtureState.request('retire', { id: first.id, digest: preview.digest }, operator))
        .status,
      'retirement-pending',
    );
    const after = (await fixtureState.readDispatchState()).records as Record<string, unknown>[];
    assert.deepEqual(after[1], (before.records as Record<string, unknown>[])[1]);
    assert.equal(
      (after[0]!.retirement as { operatorRequest: { caller: string } }).operatorRequest.caller,
      'operator',
    );
  });

  it('should reset only the selected task from an unrelated managed operator chat', async () => {
    const first = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: first.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnStatus = 'completed';
    fixtureState.native!.turnEnded = true;
    await fixtureState.next();
    const store = await fixtureState.workStore();
    await store.exclusive(async (state, save) => {
      state.records.push({
        ...structuredClone(state.records[0]!),
        id: 'b'.repeat(64),
        issueKey: 'c'.repeat(64),
        intakeId: 'c'.repeat(64),
        threadId: 'operator',
      });
      await save();
    });
    const before = await store.read();
    const preview = await fixtureState.request('reset', { id: first.id }, { threadId: 'operator' });
    assert.equal(preview.status, 'reset-available');
    const input = { id: first.id, digest: preview.digest };
    await assert.rejects(
      fixtureState.request('reset', input, {
        threadId: 'operator',
        native: {
          ...fixtureState.deps.native!,
          operatorInput: async () => {
            throw new Error('reply-native-user-input-required');
          },
        },
      }),
      /reply-native-user-input-required/,
    );
    assert.deepEqual(await store.read(), before);
    assert.equal(
      (await fixtureState.request('reset', input, { threadId: 'operator' })).status,
      'reset',
    );
    const after = await store.read();
    assert.equal(after.records[0]!.reset?.by, 'operator');
    assert.deepEqual(after.records[1], before.records[1]);
  });

  it('should reject reset from intake or child chats, unfinished work, stale previews, and active chats', async () => {
    const first = await fixtureState.prepare();
    const operator = { threadId: 'operator' };
    await assert.rejects(
      fixtureState.request('reset', { id: first.id }),
      /dispatch-operator-caller-required/,
    );
    await assert.rejects(
      fixtureState.request('reset', { id: first.id }, operator),
      /dispatch-reset-unavailable/,
    );
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: first.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    await assert.rejects(
      fixtureState.request('reset', { id: first.id }, { threadId: 'issue-thread' }),
      /dispatch-operator-caller-required/,
    );
    await assert.rejects(
      fixtureState.request('reset', { id: first.id }, operator),
      /dispatch-reset-chat-active/,
    );
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnStatus = 'completed';
    fixtureState.native!.turnEnded = true;
    const preview = await fixtureState.request('reset', { id: first.id }, operator);
    fixtureState.native!.turnId = 'later-turn';
    await assert.rejects(
      fixtureState.request('reset', { id: first.id, digest: preview.digest }, operator),
      /dispatch-recovery-stale/,
    );
    fixtureState.native!.turnId = 'first-turn';
    await assert.rejects(
      fixtureState.request('reset', { id: first.id, digest: 'stale' }, operator),
      /dispatch-recovery-stale/,
    );
    fixtureState.native!.status = 'notLoaded';
    fixtureState.native!.turnStatus = 'interrupted';
    await assert.rejects(
      fixtureState.request('reset', { id: first.id }, operator),
      /dispatch-reset-chat-active/,
    );
    fixtureState.native = undefined;
    await assert.rejects(
      fixtureState.request('reset', { id: first.id }, operator),
      /dispatch-native-readback-diverged/,
    );
    const records = (await fixtureState.readDispatchState()).records as {
      reset?: unknown;
      result: unknown;
    }[];
    assert.equal(records[0]!.reset, undefined);
    assert.equal('result' in records[0]!, false);
  });

  it('should retain a denied preparation across occurrences and start an unrelated issue', async () => {
    const first = await fixtureState.next();
    await fixtureState.addPendingSecondIssue();
    Object.assign(fixtureState.deps.native!, {
      intakeDenial: async (record: { id: string }) =>
        record.id === first.id
          ? {
              sourceThreadId: 'intake-thread',
              turnId: 'denied-turn',
              callId: 'denied-prepare',
              operation: 'prepare',
              automatic: true,
              reason: 'Repository permission denied.',
            }
          : undefined,
    });
    // the host ended the occurrence before any post-denial tracking command could run.
    fixtureState.now += 300001;
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    const second = await fixtureState.next();
    assert.equal(second.status, 'routing-required');
    assert.notEqual(second.id, first.id);
    const records = (await fixtureState.readDispatchState()).records as {
      id: string;
      denial?: unknown;
    }[];
    assert.ok(records.find((record) => record.id === first.id)!.denial);
    const prepared = await fixtureState.request('prepare', {
      id: second.id,
      digest: second.digest,
      title: 'repair unrelated issue',
      assessment: { complexity: 'medium', reason: 'Contained.' },
    });
    assert.equal(prepared.status, 'prepared');
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: second.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    assert.equal((await fixtureState.next()).status, 'idle');
    const response = String((await fixtureState.report()).response);
    assert.ok(response.includes('owner/repo#3'));
    assert.ok(response.includes('[owner/repo#4](codex://threads/issue-thread)'));
    assert.match(response, /Repository permission denied/);
    assert.match(response, /retry-denied/);
    fixtureState.now += 300001;
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    assert.equal((await fixtureState.next()).status, 'idle');
    assert.ok(String((await fixtureState.report()).response).includes('DONT_NOTIFY'));
    await fixtureState.reassign();
    assert.equal((await fixtureState.next()).status, 'idle');
    const operator = { threadId: 'operator' };
    await assert.rejects(
      fixtureState.request('retry-denied', { id: first.id }, operator),
      /approval-required/,
    );
    const preview = await fixtureState.request(
      'retry-denied',
      { id: first.id, approvedCallId: 'denied-prepare' },
      operator,
    );
    await assert.rejects(
      fixtureState.request(
        'retry-denied',
        { id: first.id, approvedCallId: 'denied-prepare', digest: 'stale' },
        operator,
      ),
      /recovery-stale/,
    );
    assert.equal(
      (
        await fixtureState.request(
          'retry-denied',
          { id: first.id, approvedCallId: 'denied-prepare', digest: preview.digest },
          operator,
        )
      ).status,
      'retry-ready',
    );
    Object.assign(fixtureState.deps.native!, { intakeDenial: async () => undefined });
    assert.equal((await fixtureState.next()).id, first.id);
  });

  it('should reconcile a current occurrence refusal without repeating preparation', async () => {
    const first = await fixtureState.next();
    await fixtureState.addPendingSecondIssue();
    fixtureState.deps.native!.intakeDenial = async (record) =>
      record.id === first.id
        ? {
            sourceThreadId: 'intake-thread',
            turnId: 'denied-turn',
            callId: 'refused',
            operation: 'prepare',
            automatic: false,
          }
        : undefined;
    const reconciled = await fixtureState.request('reconcile', { id: first.id });
    assert.equal(reconciled.nextAction, 'next');
    assert.equal(reconciled.status, 'blocked');
    const held = await fixtureState.request('prepare', {
      id: first.id,
      digest: first.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Contained.' },
    });
    assert.equal(held.status, 'blocked');
    assert.notEqual((await fixtureState.next()).id, first.id);
    const retained = (
      (await fixtureState.readDispatchState()).records as { request?: unknown; denial?: unknown }[]
    )[0]!;
    assert.equal(retained.request, undefined);
    assert.ok(retained.denial);
  });

  it('should release only a verified denied creation reservation and keep its request', async () => {
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({
        ...fixtureState.manifest,
        github: {
          ...fixtureState.manifest.github,
          'max-concurrent-items': 1,
        },
      }),
    );
    const first = await fixtureState.prepare();
    await fixtureState.addPendingSecondIssue();
    await fixtureState.next();
    assert.equal((await fixtureState.next()).status, 'at-capacity');
    fixtureState.deps.native!.intakeDenial = async (record) =>
      record.id === first.id
        ? {
            sourceThreadId: 'intake-thread',
            turnId: 'denied-turn',
            callId: 'denied-call',
            operation: 'create',
            automatic: false,
          }
        : undefined;
    const second = await fixtureState.next();
    assert.equal(second.status, 'routing-required');
    assert.notEqual(second.id, first.id);
    const retained = (
      (await fixtureState.readDispatchState()).records as {
        request: unknown;
        denial?: { operation: string };
      }[]
    )[0]!;
    assert.deepEqual(retained.request, first.request);
    assert.equal(retained.denial!.operation, 'create');
    const operator = { threadId: 'operator' };
    const preview = await fixtureState.request('retry-denied', { id: first.id }, operator);
    assert.equal(
      (
        await fixtureState.request(
          'retry-denied',
          { id: first.id, digest: preview.digest },
          operator,
        )
      ).status,
      'retry-ready',
    );
  });

  for (const code of ['dispatch-denial-scope-unresolved'])
    it('should stop unrelated intake on ' + code, async () => {
      const first = await fixtureState.next();
      await fixtureState.addPendingSecondIssue();
      fixtureState.deps.native!.intakeDenial = async () => {
        throw new Error(code);
      };
      const stopped = await fixtureState.next();
      assert.equal(stopped.nextAction, 'report');
      assert.equal(stopped.code, code);
      fixtureState.now += 300001;
      await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
      assert.equal((await fixtureState.next()).nextAction, 'report');
      const records = (await fixtureState.readDispatchState()).records as {
        id: string;
        request?: unknown;
      }[];
      assert.equal(records.length, 1);
      assert.equal(records[0]!.id, first.id);
      assert.equal(records[0]!.request, undefined);
    });

  for (const code of [
    'dispatch-denial-history-unavailable',
    'dispatch-denial-execution-unresolved',
  ])
    it('should hold only the task with ' + code + ' and keep its reservation', async () => {
      const first = await fixtureState.prepare();
      await fixtureState.addPendingSecondIssue();
      fixtureState.deps.native!.intakeDenial = async (record) => {
        if (record.id === first.id) throw new Error(code);
        return undefined;
      };
      assert.equal((await fixtureState.request('observe-denials')).status, 'ready');
      const second = await fixtureState.next();
      assert.equal(second.status, 'routing-required', JSON.stringify(second));
      assert.notEqual(second.id, first.id);
      const held = ((await fixtureState.readDispatchState()).records as DispatchRecord[]).find(
        (r) => r.id === first.id,
      )!;
      assert.deepEqual(held.request, first.request);
      assert.equal(held.denial, undefined);
    });

  it('should stop on shared authentication but continue past a repository permission failure', async () => {
    await fixtureState.addPendingSecondIssue();
    const connect = fixtureState.deps.connect!;
    for (const classification of ['permission', 'authentication'] as const) {
      fixtureState.deps.connect = async (...args) => {
        const client = await connect(...args);
        return {
          ...client,
          getItemContext: async () => {
            throw Object.assign(new Error('provider-unavailable'), {
              providerDiagnostic: providerDiagnostic('github', 'api-request', classification),
            });
          },
        };
      };
      const failed = await fixtureState.next();
      assert.equal(failed.nextAction, classification === 'permission' ? 'next' : 'report');
    }
  });

  it('should not guess missing native anchors for a routing attempt', async () => {
    const first = await fixtureState.next();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.preparationObservation;
      await save();
    });
    const blocked = await fixtureState.next();
    assert.notEqual(blocked.nextAction, 'report');
    const held = ((await fixtureState.readDispatchState()).records as DispatchRecord[]).find(
      (r) => r.id === first.id,
    )!;
    assert.equal(held.preparationObservation, undefined);
  });
});
