import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse, stringify } from 'smol-toml';

import {
  acknowledgeCodexAutomation,
  inspectCodexAutomations,
  inspectCodexDispatchActivation,
  prepareCodexAutomation,
  syncCodexAutomationThreads,
} from '../agent/codex-automations.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { connectCodexGitHub, inspectCodexIntake, runCodexIntake } from '../agent/codex-intake.ts';
import { codexIntakeJobs } from '../agent/codex-intake-policy.ts';
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
  it('should reuse one schedule and chat and pause only its owned intake after manifest corruption', async () => {
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
    await saveNative(prepared.request);
    assert.equal(creates, 1);
    assert.equal(conversations.get('intake-thread')!.name, 'ISSUE ASSIGNMENTS');
    assert.equal(conversations.get('intake-thread')!.model, 'gpt-6-luna');
    assert.equal(conversations.get('intake-thread')!.effort, 'medium');
    const inspection = await inspectCodexIntake(pluginData, { codexHome });
    assert.ok('baselineAt' in inspection);
    assert.equal(inspection.baselineAt, baseline);
    assert.equal(inspection.records!.length, 0);
    await writeFile(join(workspace, 'agent.yaml'), '{broken');
    assert.equal((await runCodexIntake(pluginData, false, { codexHome })).changed, true);
    assert.equal((await runCodexIntake(pluginData, false, { codexHome })).changed, false);
    const retained = await inspectCodexIntake(pluginData, { codexHome });
    assert.equal(retained.code, 'intake-binding-unavailable');
    assert.equal(retained.baselineAt, baseline);
    assert.equal(retained.checkpoint, baseline);
    assert.deepEqual(retained.records, inspection.records);
    const cleanup = await plan();
    assert.equal(cleanup.actions.length, 1);
    assert.equal(cleanup.actions[0]!.id, nativeId);
    assert.equal(cleanup.actions[0]!.expected.status, 'PAUSED');
    const pause = await prepareCodexAutomation(pluginData, cleanup.digest, {}, deps);
    await saveNative(pause.request);
    await acknowledgeCodexAutomation(pluginData, cleanup.digest, undefined, deps);
    assert.equal((await plan()).actions.length, 0);
    assert.equal(creates, 1);
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    const reenable = await plan();
    assert.equal(reenable.actions[0]!.id, nativeId);
    const resume = await prepareCodexAutomation(pluginData, reenable.digest, {}, deps);
    await saveNative(resume.request);
    // policy can disappear after the native action; acknowledgment must still permit cleanup.
    await rm(join(workspace, 'agent.yaml'));
    await acknowledgeCodexAutomation(pluginData, reenable.digest, undefined, deps);
    assert.equal((await plan()).actions[0]!.expected.status, 'PAUSED');
    assert.equal(creates, 1);
  });
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
});
