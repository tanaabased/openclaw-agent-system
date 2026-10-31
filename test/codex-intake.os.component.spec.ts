import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse, stringify } from 'smol-toml';

import planCodexAutomations, { codexAutomationMarker } from '../agent/codex-automation-plan.ts';
import type { NativeAutomation } from '../agent/codex-automation-state.ts';
import { codexQuietHeartbeatInstructions } from '../agent/codex-heartbeat.ts';
import {
  acknowledgeCodexAutomation,
  inspectCodexAutomations,
  inspectCodexDispatchActivation,
  prepareCodexAutomation,
  syncCodexAutomationThreads,
} from '../agent/codex-automations.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import {
  connectCodexGitHub,
  inspectCodexIntake,
  runCodexIntake,
  selectCodexIntake,
} from '../agent/codex-intake.ts';
import {
  codexIntakeJobs,
  codexIntakePolicy,
  intakeAutomationId,
} from '../agent/codex-intake-policy.ts';
import codexAutomationSchedule from '../agent/codex-automation-schedule.ts';
import { baseline, intakeFixture, originalIntakeDigest } from './github-intake-fixture.ts';

const models = {
  default: { model: 'openai/gpt-6-astra', effort: 'high' },
  low: { model: 'openai/gpt-6-luna', effort: 'medium' },
  medium: { model: 'openai/gpt-6.1-sol', effort: 'high' },
  high: { model: 'openai/gpt-6-astra', effort: 'high' },
} as const;
const manifest = {
  'schema-version': 1,
  agent: { id: 'receiver' },
  models,
  github: {
    username: 'receiver',
    'schema-version': 3,
    runtimes: ['codex'],
    'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
    'issue-assignment': {
      mode: 'plan',
      allowed: [{ login: 'receiver', 'node-id': 'U_receiver' }],
    },
  },
};

describe('agent/codex-intake', () => {
  let root: string, workspace: string, pluginData: string, codexHome: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-intake-'));
    workspace = join(root, 'workspace');
    pluginData = join(root, 'plugin');
    codexHome = join(root, 'codex');
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    await bindCodexWorkspace(pluginData, workspace);
  });
  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });
  it('should apply routing precedence and live reorder without reinstalling or losing admitted work', async () => {
    const provider = intakeFixture();
    const assigned = provider.events.splice(0);
    let now = baseline;
    const deps = {
      codexHome,
      assertActive: async () => {},
      now: () => now,
      connect: async () => provider.client,
    };
    const configure = async (routing: string[]) =>
      writeFile(
        join(workspace, 'agent.yaml'),
        JSON.stringify({
          ...manifest,
          github: {
            ...manifest.github,
            routing,
            'allowed-repository-owners': 'ignored invalid value',
          },
        }),
      );
    await configure(['!owner/repo', 'owner/*']);
    await runCodexIntake(pluginData, true, deps);
    provider.events.push(...assigned);
    now += 120000;
    const denied = await runCodexIntake(pluginData, false, deps);
    assert.equal('repositoryScope' in denied && denied.repositoryScope?.[0]?.reason, 'excluded');
    await configure(['owner/*', '!owner/repo']);
    now += 60000;
    const included = await runCodexIntake(pluginData, false, deps);
    assert.equal('admitted' in included && included.admitted, 1);
    const { store } = await selectCodexIntake(pluginData, deps);
    const before = (await store.read())!;
    await configure([]);
    now += 60000;
    await runCodexIntake(pluginData, false, deps);
    assert.deepEqual((await store.read())!.records, before.records);
    assert.equal((await store.read())!.baselineAt, baseline);
  });
  it('should preserve the activated baseline across operational policy changes', async () => {
    const provider = intakeFixture();
    provider.events.length = 0;
    let now = baseline;
    const deps = {
      codexHome,
      assertActive: async () => {},
      now: () => now,
      connect: async () => provider.client,
    };
    await runCodexIntake(pluginData, true, deps);
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        github: {
          ...manifest.github,
          ...manifest.github,
          'interval-minutes': 15,
          'max-concurrent-items': 8,
        },
      }),
    );
    provider.events.push(...intakeFixture().events);
    now += 120000;
    assert.equal((await runCodexIntake(pluginData, false, deps)).status, 'ready');
    const { store } = await selectCodexIntake(pluginData, deps);
    assert.equal((await store.read())!.records.length, 1);
  });
  it('should reject original retained-work digests as codex intake activation', async () => {
    const { client } = intakeFixture();
    let connects = 0;
    const deps = {
      codexHome,
      assertActive: async () => {},
      now: () => baseline,
      connect: async () => {
        connects++;
        return client;
      },
    };
    await runCodexIntake(pluginData, true, deps);
    const selected = await selectCodexIntake(pluginData, deps);
    const original = originalIntakeDigest(selected.manifest);
    await selected.store.exclusive(async (state, save) => {
      state!.policyDigest = original;
      await save(state!);
    });
    assert.equal((await inspectCodexIntake(pluginData, deps)).status, 'ready');
    const before = connects;
    assert.equal((await runCodexIntake(pluginData, false, deps)).status, 'ready');
    assert.equal((await selected.store.read())!.baselineAt, baseline);
    assert.ok(connects > before);
  });
  it('should reactivate after a retained provider blocker', async () => {
    const { client } = intakeFixture();
    let now = baseline;
    const deps = {
      codexHome,
      assertActive: async () => {},
      now: () => now,
      connect: async () => client,
    };
    await runCodexIntake(pluginData, true, deps);
    const { store } = await selectCodexIntake(pluginData, deps);
    await store.exclusive(async (state, save) => {
      state!.blocker = {
        code: 'intake-provider-unavailable',
        since: now,
        retryAfter: now + 300000,
      };
      await save(state!);
    });
    now += 1;
    const result = await runCodexIntake(pluginData, true, deps);
    assert.equal(result.status, 'ready');
    assert.equal('recovered' in result && result.recovered, true);
    const activated = (await store.read())!;
    assert.equal(activated.blocker, undefined);
    assert.equal((await runCodexIntake(pluginData, false, deps)).changed, false);
  });

  it('should retain activation failures and provider cooldown', async () => {
    const { client } = intakeFixture();
    const deps = {
      codexHome,
      assertActive: async () => {},
      now: () => baseline,
      connect: async () => client,
    };
    await runCodexIntake(pluginData, true, deps);
    const failure = await runCodexIntake(pluginData, true, {
      ...deps,
      connect: async () => {
        throw new Error('provider down');
      },
    });
    assert.equal(failure.status, 'blocked');
    assert.equal('code' in failure && failure.code, 'intake-provider-unavailable');
    const cooldown = await runCodexIntake(pluginData, false, {
      ...deps,
      connect: async () => {
        assert.fail('cooldown must not contact the provider');
      },
    });
    assert.equal(cooldown.changed, false);
  });

  it('should retain disabled policy evidence without clearing assignments', async () => {
    const { client } = intakeFixture();
    const deps = {
      codexHome,
      assertActive: async () => {},
      now: () => baseline,
      connect: async () => client,
    };
    await runCodexIntake(pluginData, true, deps);
    const { store } = await selectCodexIntake(pluginData, deps);
    const before = (await store.read())!;
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({ ...manifest, github: { username: 'receiver' } }),
    );
    const denied = await runCodexIntake(pluginData, false, {
      ...deps,
      connect: async () => {
        assert.fail('disabled policy must not contact the provider');
      },
    });
    assert.equal('code' in denied && denied.code, 'intake-policy-disabled');
    const after = (await store.read())!;
    assert.deepEqual(after.records, before.records);
    assert.equal(after.checkpoint, before.checkpoint);
  });

  it('should report provider failure once and recovery once without losing new assignments', async () => {
    const fixture = intakeFixture();
    let now = baseline;
    let unavailable = false;
    const deps = {
      codexHome,
      now: () => now,
      assertActive: async () => {},
      connect: async () => {
        if (unavailable) throw new Error('sensitive provider output');
        return fixture.client;
      },
    };
    await runCodexIntake(pluginData, true, deps);
    unavailable = true;
    const first = await runCodexIntake(pluginData, false, deps);
    assert.ok('notice' in first);
    assert.equal(first.notice?.severity, 'warning');
    assert.equal(first.notice?.notify, true);
    assert.doesNotMatch(first.notice!.message, /sensitive provider output/);
    const repeat = await runCodexIntake(pluginData, false, deps);
    assert.ok('notice' in repeat);
    assert.equal(repeat.notice?.notify, false);
    now += 300001;
    unavailable = false;
    const recovered = await runCodexIntake(pluginData, false, deps);
    assert.ok('notice' in recovered);
    assert.equal(recovered.notice?.severity, 'info');
    assert.equal(recovered.notice?.notify, true);
    assert.equal((await runCodexIntake(pluginData, false, deps)).changed, false);
  });

  it('should validate native account responses through the shared provider boundary', async () => {
    await symlink('/usr/bin/true', join(root, 'gh'));
    const originalPath = process.env.PATH;
    process.env.PATH = root;
    try {
      const identity = { login: 'receiver', nodeId: 'U_receiver', type: 'User' };
      const connect = (value: unknown) =>
        connectCodexGitHub(workspace, new AbortController().signal, async () => ({
          code: 0,
          killed: false,
          signal: null,
          stderr: '',
          stdout: JSON.stringify(value),
          termination: 'exit',
        }));
      assert.deepEqual((await connect(identity)).identity, identity);
      for (const invalid of [
        { ...identity, login: 'invalid login' },
        { ...identity, nodeId: 'invalid node id' },
        { ...identity, type: 'Bot' },
      ]) {
        await assert.rejects(connect(invalid), { code: 'intake-github-identity-invalid' });
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
  it('should inspect without authenticating and refuse unactivated or mismatched native identity', async () => {
    const deps = {
      codexHome,
      connect: async () => {
        throw new Error('must not authenticate');
      },
    };
    assert.equal((await inspectCodexIntake(pluginData, deps)).code, 'intake-activation-required');
    await assert.rejects(runCodexIntake(pluginData, false, deps), {
      code: 'intake-activation-required',
    });
    const { client } = intakeFixture();
    await assert.rejects(
      runCodexIntake(pluginData, true, {
        codexHome,
        connect: async () => ({
          ...client,
          identity: { ...client.identity, nodeId: 'U_impostor' },
        }),
      }),
      { code: 'intake-github-identity-mismatch' },
    );
  });
  it('should preserve activation filesystem denials without rewriting intake health', async () => {
    const fixture = intakeFixture();
    const deps = { codexHome, now: () => baseline, connect: async () => fixture.client };
    await runCodexIntake(pluginData, true, deps);
    const { store } = await selectCodexIntake(pluginData, deps);
    const before = await store.read();
    for (const code of ['EPERM', 'EACCES']) {
      const denial = Object.assign(new Error('denied'), { code });
      await assert.rejects(
        runCodexIntake(pluginData, false, {
          ...deps,
          assertActive: async () => {
            throw denial;
          },
          connect: async () => {
            assert.fail('activation must precede provider access');
          },
        }),
        (error: unknown) => error === denial,
      );
      assert.deepEqual(await store.read(), before);
    }
  });

  it('should finish an accepted scan across pause and deduplicate after resume', async () => {
    const fixture = intakeFixture();
    fixture.events[0]!.createdAt = new Date(baseline - 1000).toISOString();
    const deps = {
      codexHome,
      now: () => baseline,
      assertActive: async () => {},
      connect: async () => fixture.client,
    };
    await runCodexIntake(pluginData, true, deps);
    const before = await inspectCodexIntake(pluginData, deps);
    const disabled = structuredClone(manifest);
    Object.assign(disabled.github['issue-assignment'], { paused: true });
    fixture.events[0]!.createdAt = new Date(baseline + 1000).toISOString();
    const raced = await runCodexIntake(pluginData, false, {
      ...deps,
      now: () => baseline + 60000,
      connect: async () => {
        await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(disabled));
        return fixture.client;
      },
    });
    assert.ok('admitted' in raced);
    assert.equal(raced.admitted, 1);
    const stopped = await inspectCodexIntake(pluginData, deps);
    assert.equal(stopped.baselineAt, before.baselineAt);
    assert.equal(stopped.records?.length, 1);
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    const resumed = await runCodexIntake(pluginData, true, {
      ...deps,
      now: () => baseline + 120000,
    });
    assert.ok('admitted' in resumed);
    assert.equal(resumed.admitted, 0);
    const repeated = await runCodexIntake(pluginData, false, {
      ...deps,
      now: () => baseline + 180000,
    });
    assert.ok('admitted' in repeated);
    assert.equal(repeated.admitted, 0);
    const retained = await inspectCodexIntake(pluginData, deps);
    assert.equal(retained.baselineAt, baseline);
    assert.equal(retained.records?.length, 1);
  });

  async function checkReconciliation(
    disable: 'manifest corruption' | 'workflow disable',
    value = manifest,
    legacy = false,
  ) {
    const manifest = value;
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    const fixture = intakeFixture();
    fixture.events[0]!.createdAt = new Date(baseline - 1000).toISOString();
    const conversations = new Map<
      string,
      { id: string; name?: string; model?: string; effort?: string }
    >();
    const section = { sectionId: 'intake-section', name: 'AGENT SYSTEM', itemKeys: [] as string[] };
    const inputs = {
      nativeInventory: {
        schemaVersion: 4,
        sections: [section],
        unavailableHosts: [],
        unavailableSources: [],
      },
    };
    let creates = 0;
    const deps = {
      codexHome,
      intake: { now: () => baseline, connect: async () => fixture.client },
      threadAdapter: {
        async lookup(id: string) {
          return conversations.get(id) ?? null;
        },
        async create(
          _record: unknown,
          save: (id: string) => Promise<void>,
          _fresh: boolean,
          settings?: { model?: string; effort?: string },
        ) {
          creates++;
          const id = 'intake-thread';
          await save(id);
          conversations.set(id, { id, ...settings });
          section.itemKeys.push(`codex:thread:local:${id}`);
          return id;
        },
        async rename(id: string, name: string) {
          conversations.set(id, { ...conversations.get(id), id, name });
        },
      },
    };
    const plan = () => inspectCodexAutomations(pluginData, inputs, deps);
    const first = await plan();
    assert.equal(first.status, 'requires-native-app-sync');
    assert.ok(first.findings.some((finding) => finding.code === 'automation-thread-sync-required'));
    await assert.rejects(prepareCodexAutomation(pluginData, first.digest, inputs, deps), {
      code: 'automation-plan-stale-or-blocked',
    });
    await syncCodexAutomationThreads(pluginData, first.digest, inputs, deps);
    const desired = await plan();
    await assert.rejects(
      prepareCodexAutomation(pluginData, desired.digest, inputs, {
        ...deps,
        intake: {
          ...deps.intake,
          connect: async () => ({
            ...fixture.client,
            identity: { ...fixture.client.identity, nodeId: 'U_wrong' },
          }),
        },
      }),
      { code: 'intake-github-identity-mismatch' },
    );
    const prepared = await prepareCodexAutomation(pluginData, desired.digest, inputs, deps);
    assert.equal(prepared.request.kind, 'heartbeat');
    assert.equal(prepared.request.rrule, 'FREQ=MINUTELY;INTERVAL=5');
    assert.equal(prepared.request.name, '📥 ISSUE ASSIGNMENTS');
    const nativeId = 'intake-job';
    async function saveNative(request: typeof prepared.request) {
      const saved = parse(
        await readFile(resolve('fixtures/codex-automation-heartbeat.approved.txt'), 'utf8'),
      );
      delete saved.notification_policy;
      Object.assign(saved, {
        id: nativeId,
        name: request.name,
        prompt: request.prompt,
        status: request.status,
        rrule: request.rrule,
        target_thread_id: 'intake-thread',
      });
      await mkdir(join(codexHome, 'automations', nativeId), { recursive: true });
      await writeFile(
        join(codexHome, 'automations', nativeId, 'automation.toml'),
        stringify(saved),
      );
    }
    await saveNative(prepared.request);
    await acknowledgeCodexAutomation(pluginData, desired.digest, undefined, deps);
    assert.equal((await plan()).status, 'aligned');
    assert.equal((await plan()).actions.length, 0);
    if (!legacy) {
      const selected = await selectCodexIntake(pluginData, deps);
      const before = await selected.store.read();
      const file = (await readdir(pluginData)).find(
        (name) => name.startsWith('codex-automations-') && name.endsWith('.json'),
      )!;
      const path = join(pluginData, file);
      const original = await readFile(path, 'utf8');
      for (const mode of ['create', 'update'] as const) {
        const pendingLedger = JSON.parse(original);
        pendingLedger.pending = {
          digest: 'a'.repeat(64),
          manifestDigest: 'pending-manifest',
          action: {
            manifestId: 'nightly-refresh',
            mode,
            ...(mode === 'update' ? { id: 'nightly-refresh-job' } : {}),
            expected: {
              ...pendingLedger.records[0].definition,
              name: '🌙 NIGHTLY REFRESH',
            },
            removed: false,
          },
          targetBefore: { hash: 'b'.repeat(64), nativeIds: [] },
        };
        await writeFile(path, JSON.stringify(pendingLedger));
        assert.deepEqual(
          await inspectCodexDispatchActivation(pluginData, deps, false, false, 'intake'),
          { sourceThreadId: 'intake-thread' },
        );
      }
      const pendingIntakeLedger = JSON.parse(original);
      pendingIntakeLedger.pending = {
        digest: 'c'.repeat(64),
        manifestDigest: 'pending-manifest',
        action: {
          manifestId: intakeAutomationId,
          mode: 'update',
          id: nativeId,
          expected: pendingIntakeLedger.records[0].definition,
          removed: false,
        },
        targetBefore: { hash: 'd'.repeat(64), nativeIds: [nativeId] },
      };
      await writeFile(path, JSON.stringify(pendingIntakeLedger));
      await assert.rejects(
        inspectCodexDispatchActivation(pluginData, deps, false, false, 'intake'),
        /intake-automation-update-required/,
      );
      await writeFile(path, original);
      const ledger = JSON.parse(original);
      const oldPrompt =
        'Previously reconciled automation instructions.\n\n' +
        codexAutomationMarker(ledger.scope, intakeAutomationId);
      ledger.records[0].definition.prompt = oldPrompt;
      await writeFile(path, JSON.stringify(ledger));
      await saveNative({ ...prepared.request, prompt: oldPrompt });
      await assert.rejects(
        inspectCodexDispatchActivation(pluginData, deps, false, false, 'intake'),
        /intake-automation-update-required/,
      );
      const inspection = await inspectCodexIntake(pluginData, { codexHome });
      assert.equal(inspection.code, 'intake-automation-update-required');
      assert.match(inspection.remediation!, /apply the update/);
      assert.deepEqual(await selected.store.read(), before);
      const blocked = await runCodexIntake(pluginData, false, {
        codexHome,
        now: () => baseline + 60000,
        connect: async () => assert.fail('an update must block before provider access'),
      });
      assert.equal(blocked.status, 'blocked');
      assert.ok('code' in blocked);
      assert.equal(blocked.code, 'intake-automation-update-required');
      assert.ok('notice' in blocked && blocked.notice!.message.startsWith('> ## ✨ '));
      assert.equal((await selected.store.read())!.baselineAt, before!.baselineAt);
      assert.deepEqual((await selected.store.read())!.records, before!.records);
      const update = await plan();
      assert.equal(update.actions[0]!.id, nativeId);
      const repair = await prepareCodexAutomation(pluginData, update.digest, inputs, deps);
      await saveNative(repair.request);
      await acknowledgeCodexAutomation(pluginData, update.digest, undefined, deps);
      assert.equal((await inspectCodexIntake(pluginData, { codexHome })).status, 'ready');
      assert.equal((await selected.store.read())!.baselineAt, before!.baselineAt);
      assert.equal(creates, 1);
    }
    if (legacy) {
      const selected = await selectCodexIntake(pluginData, deps);
      assert.notEqual(selected.policy!.digest, 'previous-policy');
      const originalPrompt = prepared.request.prompt.replace(
        selected.policy!.digest,
        originalIntakeDigest(selected.manifest),
      );
      await saveNative({ ...prepared.request, prompt: originalPrompt });
      assert.equal(
        (await inspectCodexDispatchActivation(pluginData, deps)).sourceThreadId,
        'intake-thread',
      );
      const oldPrompt = prepared.request.prompt.replace(selected.policy!.digest, 'previous-policy');
      const file = (await readdir(pluginData)).find(
        (name) => name.startsWith('codex-automations-') && name.endsWith('.json'),
      )!;
      const path = join(pluginData, file);
      const ledger = JSON.parse(await readFile(path, 'utf8'));
      ledger.records[0].definition.prompt = oldPrompt;
      await writeFile(path, JSON.stringify(ledger));
      await saveNative({ ...prepared.request, prompt: oldPrompt });
      assert.deepEqual(await inspectCodexDispatchActivation(pluginData, deps), {
        sourceThreadId: 'intake-thread',
      });
      assert.deepEqual(
        (await inspectCodexDispatchActivation(pluginData, deps, false, false, 'assessment-summary'))
          .schedule?.saved.capabilities,
        ['assessment-summary'],
      );
      await selected.store.exclusive(async (state, save) => {
        state!.policyDigest = 'previous-policy';
        await save(state!);
      });
      assert.equal((await inspectCodexIntake(pluginData, deps)).status, 'ready');
      assert.equal((await selected.store.read())!.policyDigest, 'previous-policy');
      await runCodexIntake(pluginData, false, {
        ...deps,
        ...deps.intake,
        now: () => baseline + 120000,
      });
      assert.equal((await selected.store.read())!.policyDigest, selected.policy!.digest);
      await writeFile(
        join(workspace, 'agent.yaml'),
        JSON.stringify({ ...manifest, github: { ...manifest.github, username: 'foreign' } }),
      );
      assert.equal(
        (await inspectCodexDispatchActivation(pluginData, deps)).sourceThreadId,
        'intake-thread',
      );
      await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
      await saveNative({ ...prepared.request, prompt: oldPrompt + '\nchanged consent' });
      await assert.rejects(
        inspectCodexDispatchActivation(pluginData, deps),
        /dispatch-activation-required/,
      );
      return;
    }
    assert.deepEqual(await inspectCodexDispatchActivation(pluginData, deps), {
      sourceThreadId: 'intake-thread',
    });
    assert.deepEqual(
      (await inspectCodexDispatchActivation(pluginData, deps, false, false, 'assessment-summary'))
        .schedule?.saved.capabilities,
      ['assessment-summary'],
    );
    for (const capability of ['implementation', 'review', 'publication'] as const)
      await assert.rejects(
        inspectCodexDispatchActivation(pluginData, deps, false, false, capability),
        /workflow-schedule-reconciliation-required/,
      );
    await assert.rejects(
      inspectCodexDispatchActivation(pluginData, deps, true),
      /dispatch-activation-required/,
    );
    await saveNative({ ...prepared.request, status: 'PAUSED' });
    assert.deepEqual(await inspectCodexDispatchActivation(pluginData, deps, true), {
      sourceThreadId: 'intake-thread',
    });
    await assert.rejects(
      inspectCodexDispatchActivation(pluginData, deps),
      /intake-automation-paused/,
    );
    await saveNative({ ...prepared.request, prompt: 'Previously authorized intake only.' });
    await assert.rejects(
      inspectCodexDispatchActivation(pluginData, deps),
      /dispatch-activation-required/,
    );
    assert.equal(
      (await inspectCodexDispatchActivation(pluginData, deps, false, true)).sourceThreadId,
      'intake-thread',
    );
    await saveNative(prepared.request);
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        git: { worktrees: { repositories: { 'working-directory': '../checkouts' } } },
      }),
    );
    assert.equal(
      (await inspectCodexDispatchActivation(pluginData, deps)).sourceThreadId,
      'intake-thread',
    );
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    assert.deepEqual(await inspectCodexDispatchActivation(pluginData, deps), {
      sourceThreadId: 'intake-thread',
    });
    assert.equal(creates, 1);
    assert.equal(conversations.get('intake-thread')!.name, 'ISSUE ASSIGNMENTS');
    assert.equal(conversations.get('intake-thread')!.model, 'gpt-6-luna');
    assert.equal(conversations.get('intake-thread')!.effort, 'medium');
    const inspection = await inspectCodexIntake(pluginData, { codexHome });
    assert.ok('baselineAt' in inspection);
    assert.equal(inspection.baselineAt, baseline);
    assert.equal(inspection.records!.length, 0);
    if (disable === 'workflow disable') {
      for (const mode of ['work', 'auto']) {
        const work = structuredClone(manifest);
        Object.assign(work.github['issue-assignment'], {
          mode,
          implementation: { skill: 'company:implement' },
        });
        await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(work));
        const activated = await inspectCodexDispatchActivation(
          pluginData,
          deps,
          false,
          false,
          'implementation',
        );
        assert.equal(activated.sourceThreadId, 'intake-thread');
        assert.equal(activated.schedule?.current.automationId, nativeId);
        await assert.rejects(
          inspectCodexDispatchActivation(pluginData, deps, false, false, 'review'),
          /schedule-reconciliation-required/,
        );
        await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
      }
    }
    const disabled = structuredClone(manifest);
    Object.assign(disabled.github['issue-assignment'], { paused: true });
    await writeFile(
      join(workspace, 'agent.yaml'),
      disable === 'manifest corruption' ? '{broken' : JSON.stringify(disabled),
    );
    assert.equal(
      (await runCodexIntake(pluginData, false, { codexHome, now: () => baseline })).changed,
      true,
    );
    assert.equal(
      (await runCodexIntake(pluginData, false, { codexHome, now: () => baseline })).changed,
      false,
    );
    const retained = await inspectCodexIntake(pluginData, { codexHome });
    assert.equal(
      retained.code,
      disable === 'manifest corruption'
        ? 'intake-manifest-unavailable'
        : 'intake-automation-paused',
    );
    assert.equal(retained.baselineAt, baseline);
    assert.equal(retained.checkpoint, baseline);
    assert.deepEqual(retained.records, inspection.records);
    const cleanup = await plan();
    assert.equal(cleanup.actions.length, 1);
    assert.equal(cleanup.actions[0]!.id, nativeId);
    assert.equal(cleanup.actions[0]!.expected.status, 'PAUSED');
    const pause = await prepareCodexAutomation(pluginData, cleanup.digest, inputs, {
      ...deps,
      intake: {
        connect: async () => {
          throw new Error('disable must not authenticate');
        },
      },
    });
    await saveNative(pause.request);
    await acknowledgeCodexAutomation(pluginData, cleanup.digest, undefined, deps);
    assert.equal((await plan()).actions.length, 0);
    assert.equal(creates, 1);
    if (disable === 'workflow disable') {
      assert.deepEqual(await inspectCodexDispatchActivation(pluginData, deps, false, true), {
        sourceThreadId: 'intake-thread',
      });
    }
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    const stale = await runCodexIntake(pluginData, false, {
      codexHome,
      now: () => baseline + 60000,
      connect: async () => {
        throw new Error('paused schedule must not authenticate');
      },
    });
    assert.ok('code' in stale);
    assert.equal(stale.code, 'intake-automation-paused');
    const reenable = await plan();
    assert.equal(reenable.actions[0]!.id, nativeId);
    const resume = await prepareCodexAutomation(pluginData, reenable.digest, inputs, deps);
    await saveNative(resume.request);
    await acknowledgeCodexAutomation(pluginData, reenable.digest, undefined, deps);
    assert.equal((await plan()).actions.length, 0);
    assert.equal((await inspectCodexIntake(pluginData, { codexHome })).baselineAt, baseline);
    assert.equal(creates, 1);
    // preserve cleanup after a native write whose policy disappeared before acknowledgment.
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(disabled));
    const disableAgain = await plan();
    const pauseAgain = await prepareCodexAutomation(pluginData, disableAgain.digest, inputs, deps);
    await saveNative(pauseAgain.request);
    await acknowledgeCodexAutomation(pluginData, disableAgain.digest, undefined, deps);
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    const resumeAgain = await plan();
    const activateAgain = await prepareCodexAutomation(
      pluginData,
      resumeAgain.digest,
      inputs,
      deps,
    );
    await saveNative(activateAgain.request);
    // policy can disappear after the native action; acknowledgment must still permit cleanup.
    await rm(join(workspace, 'agent.yaml'));
    await acknowledgeCodexAutomation(pluginData, resumeAgain.digest, undefined, deps);
    assert.equal((await plan()).actions[0]!.expected.status, 'PAUSED');
    assert.equal(creates, 1);
  }
  it('should retain legacy codex schedule consent and upgrade intake without reactivation', async () => {
    const value = structuredClone(manifest);
    value.github.runtimes = ['openclaw', 'codex'];
    await checkReconciliation('workflow disable', value, true);
  });
  for (const disable of ['manifest corruption', 'workflow disable'] as const)
    it(`should retain and resume the owned schedule and chat after ${disable}`, () =>
      checkReconciliation(disable));

  it('should disable absent authority and reserve the projected job id', () => {
    const { policy } = intakeFixture();
    const value = {
      schemaVersion: 1 as const,
      agent: { id: 'receiver' },
      models,
      github: { host: 'github.com' as const, username: 'receiver', notifications: policy },
    };
    assert.equal(codexIntakeJobs(value).length, 1);
    assert.throws(() => codexIntakeJobs({ ...value, models: undefined }), {
      code: 'intake-low-profile-required',
    });
    const job = codexIntakeJobs(value)[0]!;
    const originalDigest = codexIntakePolicy(value)!.digest;
    policy.reviewRequest = { paused: true, allowed: [{ login: 'other', nodeId: 'U_other' }] };
    assert.equal(codexIntakePolicy(value)!.digest, originalDigest);
    assert.deepEqual(codexIntakeJobs(value), [job]);
    policy.issueAssignment!.paused = true;
    assert.equal(codexIntakeJobs(value)[0]!.enabled, false);
    assert.equal(codexIntakePolicy(value)!.digest, originalDigest);
    policy.issueAssignment!.paused = false;
    assert.equal(codexIntakeJobs(value).length, 1);
    assert.throws(() => codexIntakeJobs({ ...value, automations: [job] }), {
      code: 'intake-automation-id-reserved',
    });
    policy.issueAssignment!.allowed = [];
    assert.equal(codexIntakeJobs(value).length, 1);
    assert.equal(
      codexAutomationSchedule({ kind: 'every', seconds: 1001 * 60, missedRun: 'native' }),
      'FREQ=MINUTELY;INTERVAL=1001',
    );
    assert.equal(
      codexAutomationSchedule({ kind: 'every', seconds: 1440 * 60, missedRun: 'native' }),
      'FREQ=HOURLY;INTERVAL=24',
    );
  });

  it('should keep installed orchestration unchanged across live workflow policy edits', () => {
    const { policy } = intakeFixture();
    const manifest = {
      schemaVersion: 1 as const,
      agent: { id: 'receiver' },
      models,
      github: { host: 'github.com' as const, username: 'receiver', notifications: policy },
    };
    const runtime = {
      nodeExecutable: '/host/node',
      entrypoint: '/plugin/codex-runtime.js',
      pluginData: '/plugin-data',
    };
    const before = codexIntakeJobs(manifest, runtime);
    assert.deepEqual(
      codexIntakeJobs(manifest, { ...runtime, nodeExecutable: '/upgraded/node' } as typeof runtime),
      before,
    );
    policy.issueAssignment!.mode = 'work';
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    policy.issueAssignment!.allowed = [];
    assert.deepEqual(codexIntakeJobs(manifest, runtime), before);
    policy.intervalMinutes += 5;
    assert.notDeepEqual(codexIntakeJobs(manifest, runtime), before);
  });

  it('should update the quiet response prompt on the same native schedule and chat', async () => {
    const { policy } = intakeFixture();
    const jobs = codexIntakeJobs({
      schemaVersion: 1,
      agent: { id: 'receiver' },
      models,
      github: { host: 'github.com', username: 'receiver', notifications: policy },
    });
    const job = jobs[0]!;
    if (job.payload.kind !== 'prompt') throw new Error('expected prompt');
    assert.ok(job.payload.prompt.includes(codexQuietHeartbeatInstructions));
    const scope = 'a'.repeat(64);
    const previous: NativeAutomation = {
      kind: 'heartbeat',
      destination: 'thread',
      name: job.displayName!,
      targetThreadId: 'intake-thread',
      prompt: `Previously approved intake prompt.\n\n${codexAutomationMarker(scope, job.id)}`,
      status: 'ACTIVE',
      rrule: 'FREQ=MINUTELY;INTERVAL=5',
      notificationPolicy: 'failed_runs_only',
    };
    const plan = await planCodexAutomations({
      scope,
      workspace,
      agentId: 'receiver',
      manifestDigest: 'updated-prompt',
      jobs,
      saved: [{ id: 'native-intake-job', definition: previous }],
      records: [
        { id: job.id, nativeId: 'native-intake-job', removed: false, definition: previous },
      ],
      inputs: {},
      bindings: new Map([[job.id, { id: 'intake-thread' }]]),
    });
    assert.equal(plan.status, 'requires-native-app-sync');
    assert.equal(plan.actions.length, 1);
    const action = plan.actions[0]!;
    assert.equal(action.mode, 'update');
    assert.equal(action.id, 'native-intake-job');
    assert.deepEqual(action.expected, {
      ...previous,
      prompt: `${job.payload.prompt}\n\n${codexAutomationMarker(scope, job.id)}`,
    });
  });
});
