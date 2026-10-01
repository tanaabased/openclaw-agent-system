import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse, stringify } from 'smol-toml';

import {
  acknowledgeCodexAutomation,
  cancelCodexAutomation,
  inspectCodexAutomations,
  prepareCodexAutomation,
} from '../agent/codex-automations.ts';
import codexAutomationSchedule from '../agent/codex-automation-schedule.ts';
import {
  parseSavedAutomation,
  parseAutomationReceipt,
  readCodexAutomations,
  type NativeAutomation,
} from '../agent/codex-automation-state.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import normalizeAutomationSchedule from '../manifest/automation-schedule.ts';

const capture = (name: string) =>
  readFile(resolve('fixtures', `codex-automation-${name}.approved.txt`), 'utf8');
const rejectsCode = (code: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code;

describe('agent/codex-automation-native-contract', () => {
  it('should parse recorded project and heartbeat settings without losing target or notification fields', async () => {
    const project = parseSavedAutomation(
      await capture('project'),
      'agent-system-196-paused-fixture',
    );
    assert.equal(project.definition.kind, 'cron');
    if (project.definition.kind !== 'cron') throw new Error('expected cron');
    assert.equal(project.definition.projectId, 'fixture-project');
    assert.deepEqual(project.cwds, ['/workspace/fixture']);
    assert.equal(project.definition.notificationPolicy, 'failed_runs_only');
    const heartbeat = parseSavedAutomation(
      await capture('heartbeat'),
      'agent-system-196-paused-heartbeat-fixture',
    );
    assert.equal(heartbeat.definition.kind, 'heartbeat');
    if (heartbeat.definition.kind !== 'heartbeat') throw new Error('expected heartbeat');
    assert.equal(heartbeat.definition.targetThreadId, 'fixture-thread');
  });

  it('should require structured native receipts rather than rendered view cards', async () => {
    const native = JSON.parse(await capture('native'));
    assert.equal(
      parseAutomationReceipt(native.create.response, 'create'),
      'agent-system-196-paused-fixture',
    );
    assert.equal(
      parseAutomationReceipt(native.update.response, 'update'),
      'agent-system-196-paused-fixture',
    );
    assert.throws(
      () => parseAutomationReceipt(native.view.response, 'create'),
      rejectsCode('automation-native-receipt-missing'),
    );
    // constructed failure and ambiguity cases retain the recorded response envelope.
    assert.throws(
      () => parseAutomationReceipt({ ...native.create.response, isError: true }, 'create'),
      rejectsCode('automation-native-write-failed'),
    );
    assert.throws(() =>
      parseAutomationReceipt(
        { content: [...native.create.response.content, ...native.create.response.content] },
        'create',
      ),
    );
  });

  it('should reject constructed unknown schemas, fields, malformed toml and mismatched ids', async () => {
    const recorded = await capture('project');
    for (const contents of [
      recorded.replace('version = 1', 'version = 2'),
      `${recorded}\nunknown = true\n`,
      recorded.slice(0, 23),
    ]) {
      assert.throws(() => parseSavedAutomation(contents, 'agent-system-196-paused-fixture'));
    }
    assert.throws(() => parseSavedAutomation(recorded, 'another-id'));
  });

  it('should compile recurring declarations to the captured native requests', async () => {
    const native = JSON.parse(await capture('native'));
    const schedules = JSON.parse(await capture('schedules'));
    const cases = [
      ['0 9 * * *', native.create.request.rrule],
      ['0 9 * * 1-5', schedules[0].request.rrule],
      ['0 9 1 * *', schedules[1].request.rrule],
      ['every 15 minutes', schedules[2].request.rrule],
    ];
    for (const [input, expected] of cases)
      assert.equal(codexAutomationSchedule(normalizeAutomationSchedule(input)), expected);
    for (const input of ['in 1 hour', 'every 1 second', '0 9 1 * 1', '0 9 * 1 *']) {
      assert.throws(() => codexAutomationSchedule(normalizeAutomationSchedule(input)));
    }
    assert.throws(
      () =>
        codexAutomationSchedule(
          normalizeAutomationSchedule({ cron: '0 9 * * *', timezone: 'America/New_York' }),
        ),
      rejectsCode('automation-timezone-unsupported'),
    );
  });
});

describe('agent/codex-automations', () => {
  let root: string, workspace: string, pluginData: string, codexHome: string;
  let projects: object;
  const job = (extra = '') =>
    `  - id: review\n    schedule: every 1 hour\n    prompt: Review this workspace.\n${extra}`;
  const deps = () => ({ codexHome });
  const inputs = () => ({ projects });
  const inspect = () => inspectCodexAutomations(pluginData, inputs(), deps());
  async function manifest(declaration = job()) {
    await writeFile(
      join(workspace, 'agent.yaml'),
      `schema-version: 1\nagent:\n  id: fixture\nautomations:${declaration ? '\n' + declaration : ' []\n'}`,
    );
  }
  // fake only the native write boundary, using the captured saved shape as its template.
  async function nativeWrite(expected: NativeAutomation, id = 'fixture-native') {
    const saved = parse(await capture(expected.kind === 'cron' ? 'project' : 'heartbeat'));
    Object.assign(saved, {
      id,
      name: expected.name,
      prompt: expected.prompt,
      rrule: expected.rrule,
      status: expected.status,
    });
    if (expected.notificationPolicy) saved.notification_policy = expected.notificationPolicy;
    else delete saved.notification_policy;
    if (expected.kind === 'cron')
      Object.assign(saved, {
        model: expected.model,
        reasoning_effort: expected.reasoningEffort,
        target: { type: 'project', project_id: expected.projectId },
        cwds: [workspace],
      });
    else saved.target_thread_id = expected.targetThreadId;
    await mkdir(join(codexHome, 'automations', id), { recursive: true });
    await writeFile(join(codexHome, 'automations', id, 'automation.toml'), stringify(saved));
  }
  async function syncOne() {
    const plan = await inspect();
    assert.equal(plan.status, 'requires-native-app-sync');
    const action = plan.actions[0]!;
    const prepared = await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    assert.deepEqual(prepared.request, {
      mode: action.mode,
      ...(action.id ? { id: action.id } : {}),
      ...action.expected,
    });
    await nativeWrite(action.expected, action.id);
    return acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps());
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-automations-'));
    workspace = join(root, 'workspace');
    pluginData = join(root, 'plugin-data');
    codexHome = join(root, 'codex');
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, 'config.toml'),
      'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n',
    );
    await manifest();
    await bindCodexWorkspace(pluginData, workspace);
    projects = JSON.parse(
      (await capture('lookups')).replaceAll('/workspace/fixture', workspace),
    ).projects;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should create, stay unchanged, update, pause, remove and reintroduce the same owned job', async () => {
    const before = await readdir(pluginData);
    const planned = await inspect();
    assert.deepEqual(await readdir(pluginData), before);
    assert.equal(planned.actions[0]?.expected.kind, 'cron');
    assert.deepEqual(planned.telemetry, { execution: 'unavailable', delivery: 'unavailable' });
    const first = await syncOne();
    assert.equal((await inspect()).status, 'aligned');
    assert.deepEqual((await inspect()).actions, []);
    await manifest(job().replace('Review this workspace.', 'Review its changes.'));
    assert.equal((await syncOne()).nativeId, first.nativeId);
    await manifest(job('    enabled: false\n'));
    await syncOne();
    assert.equal((await inspect()).findings[0]?.code, 'automation-disabled');
    await manifest('');
    await syncOne();
    assert.equal((await inspect()).findings[0]?.code, 'automation-disabled-retained');
    await manifest();
    assert.equal((await syncOne()).nativeId, first.nativeId);
    assert.equal((await inspect()).status, 'aligned');
  });

  it('should materialize defaults, detect referenced-content drift and preserve unrelated jobs and notification preferences', async () => {
    const unrelated = parseSavedAutomation(
      await capture('project'),
      'agent-system-196-paused-fixture',
    ).definition;
    await nativeWrite(unrelated, 'personal');
    const path = join(codexHome, 'automations', 'personal', 'automation.toml');
    const before = await readFile(path, 'utf8');
    await writeFile(join(workspace, 'prompt.md'), 'Read the latest changes.');
    await manifest(job().replace('prompt: Review this workspace.', 'prompt: {file: prompt.md}'));
    await syncOne();
    assert.equal((await inspect()).unmanagedCount, 1);
    await writeFile(join(workspace, 'prompt.md'), 'Read the latest changes and report.');
    assert.equal((await inspect()).actions.length, 1);
    await syncOne();
    await writeFile(
      join(codexHome, 'config.toml'),
      'model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n',
    );
    assert.equal((await inspect()).actions.length, 1);
    await syncOne();
    assert.equal(await readFile(path, 'utf8'), before);
  });

  it('should reject a stale plan and serialize pending writes until exact recovery', async () => {
    const plan = await inspect();
    await manifest(job().replace('Review this workspace.', 'Changed prompt.'));
    await assert.rejects(
      prepareCodexAutomation(pluginData, plan.digest, inputs(), deps()),
      rejectsCode('automation-plan-stale-or-blocked'),
    );
    const fresh = await inspect();
    await prepareCodexAutomation(pluginData, fresh.digest, inputs(), deps());
    await assert.rejects(prepareCodexAutomation(pluginData, fresh.digest, inputs(), deps()));
    await assert.rejects(
      acknowledgeCodexAutomation(pluginData, fresh.digest, undefined, deps()),
      rejectsCode('automation-readback-diverged'),
    );
    assert.equal((await inspect()).status, 'blocked');
    await nativeWrite(fresh.actions[0]!.expected);
    await assert.rejects(cancelCodexAutomation(pluginData, fresh.digest, deps()));
    await acknowledgeCodexAutomation(pluginData, fresh.digest, undefined, deps());
    assert.equal((await inspect()).status, 'aligned');
  });

  it('should cancel a failed native write only while its original saved state remains unchanged', async () => {
    const plan = await inspect();
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    await cancelCodexAutomation(pluginData, plan.digest, deps());
    assert.equal((await inspect()).status, 'requires-native-app-sync');
  });

  it('should stop on readback divergence and preserve earlier verified writes', async () => {
    await syncOne();
    await manifest(job().replace('Review this workspace.', 'Changed prompt.'));
    const plan = await inspect();
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    await nativeWrite({ ...plan.actions[0]!.expected, prompt: 'Truncated response' });
    await assert.rejects(
      acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps()),
      rejectsCode('automation-readback-diverged'),
    );
    const ledgerPath = (await readdir(pluginData)).find((name) =>
      name.startsWith('codex-automations-'),
    )!;
    const ledger = JSON.parse(await readFile(join(pluginData, ledgerPath), 'utf8'));
    assert.equal(ledger.records.length, 1);
    assert.ok(ledger.pending);
  });

  it('should fail closed on unsupported settings, missing project bindings and unknown saved schemas', async () => {
    for (const declaration of [
      job('    timeout-seconds: 5\n'),
      job().replace('every 1 hour', 'in 1 hour'),
      job().replace('prompt: Review this workspace.', 'run: echo hello'),
    ]) {
      await manifest(declaration);
      const plan = await inspect();
      assert.equal(plan.status, 'blocked');
      assert.deepEqual(plan.actions, []);
    }
    await manifest();
    assert.equal(
      (await inspectCodexAutomations(pluginData, {}, deps())).findings[0]?.code,
      'automation-projects-required',
    );
    await mkdir(join(codexHome, 'automations', 'unknown'), { recursive: true });
    await writeFile(join(codexHome, 'automations', 'unknown', 'automation.toml'), 'version = 99');
    await assert.rejects(
      readCodexAutomations(codexHome),
      rejectsCode('automation-saved-schema-unsupported'),
    );
  });

  it('should require an explicit verified thread and reject model overrides on heartbeats', async () => {
    await manifest(job('    overrides:\n      codex:\n        target: {thread: fixture-thread}\n'));
    assert.equal((await inspect()).findings[0]?.code, 'automation-thread-verification-required');
    const threads = [
      JSON.parse((await capture('lookups')).replaceAll('/workspace/fixture', workspace)).thread,
    ];
    const plan = await inspectCodexAutomations(pluginData, { projects, threads }, deps());
    assert.equal(plan.actions[0]?.expected.kind, 'heartbeat');
    await manifest(
      job(
        '    overrides:\n      codex:\n        model: gpt-6-astra\n        target: {thread: fixture-thread}\n',
      ),
    );
    assert.equal((await inspect()).findings[0]?.code, 'automation-thread-overrides-unsupported');
  });

  it('should preserve native notification preferences without declaring drift', async () => {
    const plan = await inspect();
    await syncOne();
    await nativeWrite({ ...plan.actions[0]!.expected, notificationPolicy: 'failed_runs_only' });
    assert.equal((await inspect()).status, 'aligned');
    await manifest(job().replace('Review this workspace.', 'Changed prompt.'));
    assert.equal((await inspect()).actions[0]?.expected.notificationPolicy, 'failed_runs_only');
  });

  it('should not recreate missing owned jobs or adopt orphan markers', async () => {
    const plan = await inspect();
    await nativeWrite(plan.actions[0]!.expected);
    assert.equal((await inspect()).status, 'blocked');
    await rm(join(codexHome, 'automations', 'fixture-native'), { recursive: true });
    await syncOne();
    await rm(join(codexHome, 'automations', 'fixture-native'), { recursive: true });
    const missing = await inspect();
    assert.equal(missing.status, 'blocked');
    assert.deepEqual(missing.actions, []);
    assert.equal(missing.findings[0]?.code, 'automation-native-recovery-required');
  });

  it('should validate every applicable job before preparing any native action', async () => {
    await manifest(
      job() + job().replace('id: review', 'id: other').replace('every 1 hour', 'in 1 hour'),
    );
    const plan = await inspect();
    assert.equal(plan.status, 'blocked');
    assert.deepEqual(plan.actions, []);
    await assert.rejects(prepareCodexAutomation(pluginData, plan.digest, inputs(), deps()));
    assert.deepEqual(await readCodexAutomations(codexHome), []);
  });

  it('should reject changed manifests and wrong native receipts after a write without losing pending state', async () => {
    const plan = await inspect();
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    await nativeWrite(plan.actions[0]!.expected);
    const native = JSON.parse(await capture('native'));
    await assert.rejects(
      acknowledgeCodexAutomation(pluginData, plan.digest, native.create.response, deps()),
      rejectsCode('automation-readback-diverged'),
    );
    await manifest(job().replace('Review this workspace.', 'Changed prompt.'));
    await assert.rejects(
      acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps()),
      rejectsCode('automation-pending-stale'),
    );
    assert.equal((await inspect()).status, 'blocked');
  });
});
