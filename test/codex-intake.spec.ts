import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { codexIntakeJobs, codexIntakePolicy } from '../agent/codex-intake-policy.ts';
import codexAutomationSchedule from '../agent/codex-automation-schedule.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

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
    notifications: {
      'schema-version': 2,
      runtimes: ['codex'],
      'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
      'issue-assignment': {
        mode: 'plan',
        allowed: [{ login: 'receiver', 'node-id': 'U_receiver' }],
      },
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
  it('should reactivate despite obsolete full notification queues', async () => {
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
    const cards = Array.from({ length: 100 }, (_, i) => ({
      id: i.toString(16).padStart(64, '0'),
      message: 'pending card',
      notify: false,
    }));
    await store.exclusive(async (state, save) => {
      state!.notices = cards;
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
    assert.equal(activated.noticePending, undefined);
    assert.equal(activated.notices, undefined);
    assert.equal((await runCodexIntake(pluginData, false, deps)).changed, false);
  });

  it('should retain real activation failures independently of obsolete notifications', async () => {
    const { client } = intakeFixture();
    const deps = {
      codexHome,
      assertActive: async () => {},
      now: () => baseline,
      connect: async () => client,
    };
    await runCodexIntake(pluginData, true, deps);
    const { store } = await selectCodexIntake(pluginData, deps);
    await store.exclusive(async (state, save) => {
      state!.notices = Array.from({ length: 100 }, (_, i) => ({
        id: i.toString(16).padStart(64, '0'),
        message: 'pending card',
        notify: false,
      }));
      await save(state!);
    });
    const failure = await runCodexIntake(pluginData, true, {
      ...deps,
      connect: async () => {
        throw new Error('provider down');
      },
    });
    assert.equal(failure.status, 'blocked');
    assert.equal('code' in failure && failure.code, 'intake-provider-unavailable');
    assert.equal((await store.read())!.noticePending, undefined);
    await store.exclusive(async (state, save) => {
      state!.notices = [];
      await save(state!);
    });
    const cooldown = await runCodexIntake(pluginData, false, {
      ...deps,
      connect: async () => {
        assert.fail('cooldown must not contact the provider');
      },
    });
    assert.equal(cooldown.changed, false);
    assert.equal((await store.read())!.noticePending, undefined);
    assert.equal((await store.read())!.notices, undefined);
  });

  it('should retain disabled policy evidence without a notification queue', async () => {
    const { client } = intakeFixture();
    const deps = {
      codexHome,
      assertActive: async () => {},
      now: () => baseline,
      connect: async () => client,
    };
    await runCodexIntake(pluginData, true, deps);
    const { store } = await selectCodexIntake(pluginData, deps);
    await store.exclusive(async (state, save) => {
      state!.notices = Array.from({ length: 100 }, (_, i) => ({
        id: i.toString(16).padStart(64, '0'),
        message: 'pending card',
        notify: false,
      }));
      await save(state!);
    });
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
    assert.equal(after.noticePending, undefined);
    assert.deepEqual(after.records, before.records);
    assert.deepEqual(after.notices, before.notices);
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
    const current = await selectCodexIntake(pluginData, deps);
    const saved = await current.store.read();
    assert.equal(saved?.notices, undefined);
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

  it('should reject disabled and stale scans and retain progress through explicit reactivation', async () => {
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
    Object.assign(disabled.github.notifications['issue-assignment'], { enabled: false });
    fixture.events[0]!.createdAt = new Date(baseline + 1000).toISOString();
    const raced = await runCodexIntake(pluginData, false, {
      ...deps,
      now: () => baseline + 60000,
      connect: async () => {
        await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(disabled));
        return fixture.client;
      },
    });
    assert.ok('code' in raced);
    assert.equal(raced.code, 'intake-policy-changed');
    const stopped = await inspectCodexIntake(pluginData, deps);
    assert.equal(stopped.baselineAt, before.baselineAt);
    assert.equal(stopped.checkpoint, before.checkpoint);
    assert.deepEqual(stopped.records, before.records);
    const noCredentials = {
      ...deps,
      connect: async () => {
        throw new Error('must not authenticate');
      },
    };
    await assert.rejects(runCodexIntake(pluginData, true, noCredentials), {
      code: 'intake-policy-disabled',
    });
    const idle = await runCodexIntake(pluginData, false, noCredentials);
    assert.ok('code' in idle);
    assert.equal(idle.code, 'intake-policy-disabled');
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    const resumed = await runCodexIntake(pluginData, true, {
      ...deps,
      now: () => baseline + 120000,
    });
    assert.ok('admitted' in resumed);
    assert.equal(resumed.admitted, 1);
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

  async function checkReconciliation(disable: 'manifest corruption' | 'workflow disable') {
    const fixture = intakeFixture();
    fixture.events[0]!.createdAt = new Date(baseline - 1000).toISOString();
    const conversations = new Map<
      string,
      { id: string; name?: string; model?: string; effort?: string }
    >();
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
          return id;
        },
        async rename(id: string, name: string) {
          conversations.set(id, { ...conversations.get(id), id, name });
        },
      },
    };
    const plan = () => inspectCodexAutomations(pluginData, {}, deps);
    const first = await plan();
    assert.equal(first.status, 'requires-native-app-sync');
    assert.ok(first.findings.some((finding) => finding.code === 'automation-thread-sync-required'));
    await assert.rejects(prepareCodexAutomation(pluginData, first.digest, {}, deps), {
      code: 'automation-plan-stale-or-blocked',
    });
    await syncCodexAutomationThreads(pluginData, first.digest, {}, deps);
    const desired = await plan();
    await assert.rejects(
      prepareCodexAutomation(
        pluginData,
        desired.digest,
        {},
        {
          ...deps,
          intake: {
            ...deps.intake,
            connect: async () => ({
              ...fixture.client,
              identity: { ...fixture.client.identity, nodeId: 'U_wrong' },
            }),
          },
        },
      ),
      { code: 'intake-github-identity-mismatch' },
    );
    const prepared = await prepareCodexAutomation(pluginData, desired.digest, {}, deps);
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
    assert.deepEqual(await inspectCodexDispatchActivation(pluginData, deps), {
      sourceThreadId: 'intake-thread',
    });
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
      /dispatch-activation-required/,
    );
    await saveNative({ ...prepared.request, prompt: 'Previously authorized intake only.' });
    await assert.rejects(
      inspectCodexDispatchActivation(pluginData, deps),
      /dispatch-activation-required/,
    );
    await assert.rejects(
      inspectCodexDispatchActivation(pluginData, deps, false, true),
      /dispatch-activation-required/,
    );
    await saveNative(prepared.request);
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        git: { worktrees: { repositories: { 'working-directory': '../checkouts' } } },
      }),
    );
    await assert.rejects(
      inspectCodexDispatchActivation(pluginData, deps),
      /dispatch-activation-required/,
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
        Object.assign(work.github.notifications['issue-assignment'], {
          mode,
          implementation: { skill: 'company:implement' },
        });
        await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(work));
        await assert.rejects(
          inspectCodexDispatchActivation(pluginData, deps, false, false, 'implementation'),
          /activation-required/,
        );
        const workPlan = await plan();
        const workPrepared = await prepareCodexAutomation(pluginData, workPlan.digest, {}, deps);
        await saveNative(workPrepared.request);
        await acknowledgeCodexAutomation(pluginData, workPlan.digest, undefined, deps);
        const activated = await inspectCodexDispatchActivation(
          pluginData,
          deps,
          false,
          false,
          'implementation',
        );
        assert.deepEqual(activated.schedule?.saved.capabilities, [
          'assessment',
          'implementation',
          'publication',
        ]);
        assert.equal(activated.schedule?.current.automationId, nativeId);
        assert.equal(
          (await inspectCodexDispatchActivation(pluginData, deps, false, false, 'publication'))
            .schedule?.current.sourceThreadId,
          'intake-thread',
        );
        await assert.rejects(
          inspectCodexDispatchActivation(pluginData, deps, false, false, 'review'),
          /schedule-reconciliation-required/,
        );
        await saveNative({ ...workPrepared.request, status: 'PAUSED' });
        await assert.rejects(
          inspectCodexDispatchActivation(pluginData, deps, false, false, 'publication'),
          /activation-required/,
        );
        await saveNative(workPrepared.request);
        await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
        const planAgain = await plan();
        const preparedAgain = await prepareCodexAutomation(pluginData, planAgain.digest, {}, deps);
        await saveNative(preparedAgain.request);
        await acknowledgeCodexAutomation(pluginData, planAgain.digest, undefined, deps);
        await assert.rejects(
          inspectCodexDispatchActivation(pluginData, deps, false, false, 'implementation'),
          /schedule-reconciliation-required/,
        );
      }
    }
    const disabled = structuredClone(manifest);
    Object.assign(disabled.github.notifications['issue-assignment'], { enabled: false });
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
      disable === 'manifest corruption' ? 'intake-binding-unavailable' : 'intake-policy-disabled',
    );
    assert.equal(retained.baselineAt, baseline);
    assert.equal(retained.checkpoint, baseline);
    assert.deepEqual(retained.records, inspection.records);
    const cleanup = await plan();
    assert.equal(cleanup.actions.length, 1);
    assert.equal(cleanup.actions[0]!.id, nativeId);
    assert.equal(cleanup.actions[0]!.expected.status, 'PAUSED');
    const pause = await prepareCodexAutomation(
      pluginData,
      cleanup.digest,
      {},
      {
        ...deps,
        intake: {
          connect: async () => {
            throw new Error('disable must not authenticate');
          },
        },
      },
    );
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
    assert.equal(stale.code, 'intake-activation-required');
    const reenable = await plan();
    assert.equal(reenable.actions[0]!.id, nativeId);
    const resume = await prepareCodexAutomation(pluginData, reenable.digest, {}, deps);
    await saveNative(resume.request);
    await acknowledgeCodexAutomation(pluginData, reenable.digest, undefined, deps);
    assert.equal((await plan()).actions.length, 0);
    assert.equal((await inspectCodexIntake(pluginData, { codexHome })).baselineAt, baseline);
    assert.equal(creates, 1);
    // preserve cleanup after a native write whose policy disappeared before acknowledgment.
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(disabled));
    const disableAgain = await plan();
    const pauseAgain = await prepareCodexAutomation(pluginData, disableAgain.digest, {}, deps);
    await saveNative(pauseAgain.request);
    await acknowledgeCodexAutomation(pluginData, disableAgain.digest, undefined, deps);
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    const resumeAgain = await plan();
    const activateAgain = await prepareCodexAutomation(pluginData, resumeAgain.digest, {}, deps);
    await saveNative(activateAgain.request);
    // policy can disappear after the native action; acknowledgment must still permit cleanup.
    await rm(join(workspace, 'agent.yaml'));
    await acknowledgeCodexAutomation(pluginData, resumeAgain.digest, undefined, deps);
    assert.equal((await plan()).actions[0]!.expected.status, 'PAUSED');
    assert.equal(creates, 1);
  }
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
    policy.reviewRequest = { enabled: false, allowed: [{ login: 'other', nodeId: 'U_other' }] };
    assert.equal(codexIntakePolicy(value)!.digest, originalDigest);
    assert.deepEqual(codexIntakeJobs(value), [job]);
    policy.issueAssignment!.enabled = false;
    assert.equal(codexIntakeJobs({ ...value, models: undefined }).length, 0);
    assert.equal(codexIntakePolicy(value), undefined);
    policy.issueAssignment!.enabled = true;
    assert.equal(codexIntakeJobs(value).length, 1);
    assert.throws(() => codexIntakeJobs({ ...value, automations: [job] }), {
      code: 'intake-automation-id-reserved',
    });
    policy.issueAssignment!.allowed = [];
    assert.equal(codexIntakeJobs(value).length, 0);
    assert.equal(
      codexAutomationSchedule({ kind: 'every', seconds: 1001 * 60, missedRun: 'native' }),
      'FREQ=MINUTELY;INTERVAL=1001',
    );
    assert.equal(
      codexAutomationSchedule({ kind: 'every', seconds: 1440 * 60, missedRun: 'native' }),
      'FREQ=HOURLY;INTERVAL=24',
    );
  });

  it('should include creation orchestration in both modes and continuation only in work', () => {
    const { policy } = intakeFixture();
    const manifest = {
      schemaVersion: 1 as const,
      agent: { id: 'receiver' },
      models,
      github: { host: 'github.com' as const, username: 'receiver', notifications: policy },
    };
    const runtime = {
      nodeExecutable: '/host/node',
      entrypoint: '/installed plugin/dist/codex/codex-runtime.js',
      pluginData: '/private/plugin data',
    };
    const prompt = () => {
      const job = codexIntakeJobs(manifest, runtime)[0]!;
      if (job.payload.kind !== 'prompt') throw new Error('expected prompt');
      return job.payload.prompt;
    };
    const plan = prompt();
    assert.ok(plan.includes(runtime.entrypoint));
    assert.ok(plan.includes('tools.mcp__codex_app__create_thread(prepared.request)'));
    assert.ok(!plan.includes('Installed continuation command'));
    policy.issueAssignment!.mode = 'work';
    assert.throws(() => codexIntakeJobs(manifest), {
      code: 'continuation-runtime-identity-required',
    });
    const work = prompt();
    assert.ok(
      work.includes(
        JSON.stringify([
          runtime.nodeExecutable,
          runtime.entrypoint,
          'continuation',
          '--plugin-data',
          runtime.pluginData,
        ]),
      ),
    );
    assert.match(work, /next and action:reconcile.*private tracking state/u);
    assert.match(work, /do not edit repository files.*publish a pull request/u);
    assert.match(work, /match continuationRuntime.*newest trusted context/u);
    assert.match(work, /stop on denial/u);
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
