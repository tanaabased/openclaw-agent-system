import { codexInstanceStore } from '../agent/tasks/dispatch/codex-assignment-claims.ts';
import IssuePickupEnrollmentStore from '../agent/issue-pickup-enrollment.ts';
import selectionFixture from './issue-pickup-selection-fixture.ts';
import checkCodexActivationIsolation from './codex-activation-fixture.ts';
import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse, stringify } from 'smol-toml';

import { automationHash } from '../agent/automation-hash.ts';
import { AutomationError } from '../agent/automations/automation-errors.ts';
import type {
  AutomationThread,
  AutomationThreadAdapter,
} from '../agent/automations/automation-threads.ts';
import {
  acknowledgeCodexAutomation,
  replaceCodexNotificationCoordinator,
  codexNotificationResetAutomation,
  codexNotificationResetPickupAutomation,
  cancelCodexAutomation,
  inspectCodexAutomations,
  listCodexAutomations,
  codexAutomationRunGap,
  prepareCodexAutomation,
  reconcileCodexAutomationRetirements,
  syncCodexAutomationThreads,
} from '../agent/automations/codex-automations.ts';
import { type CodexAutomationDependencies } from '../agent/automations/codex-automation-snapshot.ts';
import { inspectCodexPickupActivation } from '../agent/automations/codex-automation-activation.ts';
import codexAutomationSchedule from '../agent/automations/codex-automation-schedule.ts';
import {
  parseSavedAutomation,
  parseAutomationReceipt,
  readCodexAutomations,
  type NativeAutomation,
  type SavedAutomation,
} from '../agent/automations/codex-automation-state.ts';
import {
  bindCodexWorkspace,
  inspectCodexWorkspaceBinding,
} from '../agent/identity/codex-workspace-binding.ts';
import { intakeFixture } from './github-intake-fixture.ts';
import { prepareCodexPickupEnrollment, inspectCodexIntake } from '../agent/codex-intake.ts';
import normalizeAutomationSchedule from '../manifest/automation-schedule.ts';
import { inspectCodexSetup, installCodexSetup } from '../agent/lifecycle/codex-setup.ts';

const capture = (name: string) =>
  readFile(resolve('fixtures', `codex-automation-${name}.approved.txt`), 'utf8');
const rejectsCode = (code: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === code;

describe('agent/codex-automation-native-contract', () => {
  it('should preserve the reviewed native timezone and schedule edits through saved-state parsing', async () => {
    const captured = JSON.parse(await capture('timezone'));
    const id = 'agent-system-424-timezone-fixture';
    const unrelated = parseSavedAutomation(captured.unrelatedEdit, id);
    const updated = parseSavedAutomation(captured.scheduleEdit, id);
    assert.equal(unrelated.definition.status, 'PAUSED');
    assert.equal(updated.definition.status, 'PAUSED');
    assert.equal(
      unrelated.definition.rrule,
      'DTSTART;TZID=America/New_York:20261024T080000\nRRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0',
    );
    assert.equal(
      updated.definition.rrule,
      unrelated.definition.rrule.replace('BYHOUR=8', 'BYHOUR=9'),
    );
  });
  it('should consume the reviewed scheduled execution capture through native parsers', async () => {
    const recorded = JSON.parse(await capture('execution'));
    const id = parseAutomationReceipt(recorded.create.response, 'create');
    const active = parseSavedAutomation(recorded.create.saved, id);
    assert.equal(active.definition.status, 'ACTIVE');
    assert.equal(active.definition.rrule, 'FREQ=MINUTELY;INTERVAL=1');
    const expected = { ...recorded.create.request };
    delete expected.mode;
    assert.deepEqual(active.definition, expected);
    assert.deepEqual(active.cwds, ['/workspace/fixture']);
    assert.equal(recorded.unchangedSync.status, 'aligned');
    assert.deepEqual(recorded.unchangedSync.actions, []);
    assert.equal(parseAutomationReceipt(recorded.pause.response, 'update'), id);
    assert.equal(parseSavedAutomation(recorded.pause.saved, id).definition.status, 'PAUSED');
    const thread = JSON.parse(recorded.scheduledOccurrence.content[0].text);
    assert.equal(thread.thread.cwd, '/workspace/fixture');
    assert.equal(thread.turns[0].status, 'completed');
    assert.equal(recorded.sideEffect.bytes, 'scheduled-197-proof');
    assert.equal(recorded.runGap.code, 'automation-run-now-unsupported');
    assert.equal(recorded.historyGap.code, 'automation-history-unavailable');
    assert.equal(recorded.cleanup.testDefinitionRemoved, true);
  });

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

  it('should accept native prompt fingerprints without changing verified automation settings', async () => {
    for (const kind of ['project', 'heartbeat'] as const) {
      const contents = await capture(kind);
      const native = parse(contents);
      const id = native.id as string;
      const expected = parseSavedAutomation(contents, id);
      native.model_prompt_sha256 = 'a'.repeat(64);
      native.native_display_metadata = { revision: 2 };
      assert.deepEqual(parseSavedAutomation(stringify(native), id), expected);
      native.prompt = 'Changed native prompt';
      assert.notDeepEqual(
        parseSavedAutomation(stringify(native), id).definition,
        expected.definition,
      );
      native.prompt = 123;
      assert.throws(
        () => parseSavedAutomation(stringify(native), id),
        rejectsCode('automation-saved-schema-unsupported'),
      );
    }
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

  it('should reject unsupported versions, malformed owned fields, malformed toml and mismatched ids', async () => {
    const recorded = await capture('project');
    for (const contents of [
      recorded.replace('version = 1', 'version = 2'),
      recorded.replace('status = "PAUSED"', 'status = "UNKNOWN"'),
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
      [{ cron: '0 9 * * *' }, native.create.request.rrule],
      [{ cron: '0 9 * * *', timezone: null }, native.create.request.rrule],
      ['0 9 * * 1-5', schedules[0].request.rrule],
      ['0 9 1 * *', schedules[1].request.rrule],
      ['every 15 minutes', schedules[2].request.rrule],
    ];
    for (const [input, expected] of cases)
      assert.equal(codexAutomationSchedule(normalizeAutomationSchedule(input)), expected);
    for (const input of ['in 1 hour', 'every 1 second', '0 9 1 * 1', '0 9 * 1 *']) {
      assert.throws(() => codexAutomationSchedule(normalizeAutomationSchedule(input)));
    }
  });
});

describe('agent/codex-automations', () => {
  let root: string, workspace: string, pluginData: string, codexHome: string;
  let projects: object;
  let nativeInventory: {
    schemaVersion: number;
    unavailableHosts: string[];
    unavailableSources: string[];
    sections: Array<{ sectionId: string; name: string; itemKeys: string[] }>;
  };
  const job = (extra = '') =>
    `  - id: review\n    schedule: every 1 hour\n    prompt: Review this workspace.\n${extra}`;
  const deps = () => ({ codexHome });
  const inputs = () => ({ projects, nativeInventory });
  function applySidebar(effect: unknown) {
    const action = effect as {
      status: string;
      request?: {
        tool: string;
        arguments: { name?: string; sectionId?: string; threadId?: string };
      };
    };
    if (action.status !== 'native-action') return false;
    if (action.request?.tool === 'create_sidebar_section') {
      nativeInventory.sections.push({
        sectionId: `section-${nativeInventory.sections.length}`,
        name: action.request.arguments.name!,
        itemKeys: [],
      });
      return true;
    }
    if (action.request?.tool === 'move_thread_to_sidebar_section') {
      const key = `codex:thread:local:${action.request.arguments.threadId}`;
      for (const section of nativeInventory.sections)
        section.itemKeys = section.itemKeys.filter((item) => item !== key);
      nativeInventory.sections
        .find(({ sectionId }) => sectionId === action.request!.arguments.sectionId)!
        .itemKeys.push(key);
      return true;
    }
    return false;
  }
  async function syncThreads(dependencies: CodexAutomationDependencies) {
    for (let i = 0; i < 6; i++) {
      const plan = await inspectCodexAutomations(pluginData, inputs(), dependencies);
      const effect = await syncCodexAutomationThreads(
        pluginData,
        plan.digest,
        inputs(),
        dependencies,
      );
      if (effect.status === 'verified') return effect;
      assert.ok(applySidebar(effect), JSON.stringify(effect));
    }
    assert.fail('sidebar placement did not converge');
  }
  async function replaceCoordinator(
    before: SavedAutomation,
    dependencies: CodexAutomationDependencies,
    jobId?: string,
  ) {
    for (let i = 0; i < 6; i++) {
      const effect = await replaceCodexNotificationCoordinator(
        pluginData,
        before,
        dependencies,
        inputs(),
        jobId,
      );
      if (!applySidebar(effect)) return effect;
    }
    throw new Error('sidebar placement did not converge');
  }
  const inspect = () => inspectCodexAutomations(pluginData, inputs(), deps());
  async function ownership() {
    const name = (await readdir(pluginData)).find((entry) =>
      /^codex-automations-.*\.json$/u.test(entry),
    )!;
    const path = join(pluginData, name);
    const bytes = await readFile(path, 'utf8');
    return { path, bytes, ledger: JSON.parse(bytes) };
  }
  async function unrelatedDamagedLedger() {
    const binding = { workspace, codexHome: join(root, 'other-codex'), agentId: 'fixture' };
    const scope = automationHash({
      runtime: 'codex',
      profile: binding.codexHome,
      workspaceDir: workspace,
      agentId: binding.agentId,
    });
    const path = join(pluginData, `codex-automations-${scope}.json`);
    const contents = JSON.stringify({
      version: 1,
      scope,
      binding,
      records: 'damaged',
      pending: { broken: true },
    });
    await writeFile(path, contents, { mode: 0o600 });
    return { path, contents };
  }
  async function manifest(declaration = job()) {
    await writeFile(
      join(workspace, 'agent.yaml'),
      `schema-version: 1\nagent:\n  id: fixture\nautomations:${declaration ? '\n' + declaration : ' []\n'}`,
    );
  }
  // fake only the native write boundary, using the captured saved shape as its template.
  async function nativeWrite(expected: NativeAutomation, id = 'fixture-native') {
    const saved = parse(await capture(expected.kind === 'cron' ? 'project' : 'heartbeat'));
    saved.model_prompt_sha256 = 'b'.repeat(64);
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
  async function syncOne(
    dependencies: CodexAutomationDependencies = deps(),
    nativeId = 'fixture-native',
  ) {
    const plan = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.equal(plan.status, 'requires-native-app-sync');
    const action = plan.actions[0]!;
    const prepared = await prepareCodexAutomation(pluginData, plan.digest, inputs(), dependencies);
    assert.deepEqual(prepared.request, {
      mode: action.mode,
      ...(action.id ? { id: action.id } : {}),
      ...action.expected,
    });
    await nativeWrite(action.expected, action.id ?? nativeId);
    return acknowledgeCodexAutomation(pluginData, plan.digest, undefined, dependencies);
  }
  beforeEach(async () => {
    nativeInventory = {
      schemaVersion: 4,
      unavailableHosts: [],
      unavailableSources: [],
      sections: [],
    };
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

  it('should isolate damaged payloads belonging to another codex installation', async () => {
    const expected = await inspect();
    const { path, contents } = await unrelatedDamagedLedger();
    assert.deepEqual(await inspect(), expected);
    assert.equal(await readFile(path, 'utf8'), contents);
  });

  it('should reject damaged current, retained and ambiguous automation ownership', async () => {
    for (const binding of [
      { workspace, codexHome, agentId: 'fixture' },
      { workspace: join(root, 'prior-workspace'), codexHome, agentId: 'prior-agent' },
      undefined,
    ]) {
      const scope = binding
        ? automationHash({
            runtime: 'codex',
            profile: binding.codexHome,
            workspaceDir: binding.workspace,
            agentId: binding.agentId,
          })
        : 'a'.repeat(64);
      const path = join(pluginData, `codex-automations-${scope}.json`);
      await writeFile(path, JSON.stringify({ version: 1, scope, binding, records: 'damaged' }), {
        mode: 0o600,
      });
      await assert.rejects(inspect(), rejectsCode('automation-ownership-invalid'));
      await rm(path);
    }
    const alias = join(root, 'home-alias');
    await symlink(codexHome, alias);
    const binding = { workspace, codexHome: alias, agentId: 'fixture' };
    const scope = automationHash({
      runtime: 'codex',
      profile: alias,
      workspaceDir: workspace,
      agentId: binding.agentId,
    });
    const path = join(pluginData, `codex-automations-${scope}.json`);
    await writeFile(path, JSON.stringify({ version: 1, scope, binding, records: 'damaged' }), {
      mode: 0o600,
    });
    await assert.rejects(inspect(), rejectsCode('automation-ownership-invalid'));
  });

  it('should reject unrelated ledgers with unverified ownership envelopes', async () => {
    const binding = { workspace, codexHome: join(root, 'other-codex'), agentId: 'fixture' };
    const scope = automationHash({
      runtime: 'codex',
      profile: binding.codexHome,
      workspaceDir: workspace,
      agentId: binding.agentId,
    });
    const path = join(pluginData, `codex-automations-${scope}.json`);
    for (const damaged of [
      { version: 999, scope, binding, records: [] },
      { version: 1, scope: 'a'.repeat(64), binding, records: [] },
      { version: 1, scope, binding: { ...binding, agentId: 'wrong-agent' }, records: [] },
      { version: 1, scope, binding: { codexHome: binding.codexHome }, records: [] },
    ]) {
      await writeFile(path, JSON.stringify(damaged), { mode: 0o600 });
      await assert.rejects(inspect(), rejectsCode('automation-ownership-invalid'));
    }
  });

  it('should reconcile only the selected automation while leaving earlier changes pending', async () => {
    await manifest(job() + job().replace('id: review', 'id: selected'));
    await syncOne(deps(), 'review-native');
    await syncOne(deps(), 'selected-native');
    const before = await readCodexAutomations(codexHome);
    for (const saved of before)
      await nativeWrite({ ...saved.definition, status: 'PAUSED' }, saved.id);
    const paused = await readCodexAutomations(codexHome);
    const plan = await inspect();
    assert.deepEqual(
      plan.actions.map((item) => item.manifestId),
      ['review', 'selected'],
    );
    await assert.rejects(
      prepareCodexAutomation(pluginData, plan.digest, inputs(), deps(), 'unknown'),
      rejectsCode('automation-action-not-found'),
    );
    const prepared = await prepareCodexAutomation(
      pluginData,
      plan.digest,
      inputs(),
      deps(),
      'selected',
    );
    const action = plan.actions[1]!;
    assert.deepEqual(prepared.request, { mode: action.mode, id: action.id, ...action.expected });
    await nativeWrite(action.expected, action.id);
    await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps());
    const after = await readCodexAutomations(codexHome);
    assert.deepEqual(
      after.find((item) => item.id === 'review-native'),
      paused.find((item) => item.id === 'review-native'),
    );
    assert.equal(after.find((item) => item.id === 'selected-native')!.definition.status, 'ACTIVE');
    assert.deepEqual(
      (await inspect()).actions.map((item) => item.manifestId),
      ['review'],
    );
  });

  it('should rename and remove labels through native updates without replacing jobs', async () => {
    await syncOne();
    const [before] = await readCodexAutomations(codexHome);
    assert.equal(before!.definition.name, 'fixture: review');
    for (const label of ['🔄 NIGHTLY REFRESH', '🔄 RENAMED', undefined]) {
      await manifest(job(label ? `    display-name: "${label}"\n` : ''));
      const plan = await inspect();
      assert.equal(plan.actions.length, 1);
      assert.equal(plan.actions[0]!.mode, 'update');
      assert.equal(plan.actions[0]!.id, before!.id);
      assert.deepEqual(plan.actions[0]!.expected, {
        ...before!.definition,
        name: label ?? 'fixture: review',
      });
      await syncOne();
      const saved = await readCodexAutomations(codexHome);
      assert.equal(saved.length, 1);
      assert.equal(saved[0]!.id, before!.id);
      assert.equal(saved[0]!.definition.name, label ?? 'fixture: review');
      assert.equal((await inspect()).status, 'aligned');
    }
  });

  for (const zone of ['Europe/London', 'UTC']) {
    it(`should require review only when creating a new timezone schedule in ${zone.toLowerCase()}`, async () => {
      await manifest(job().replace('every 1 hour', `{ cron: "0 8 * * *", timezone: "${zone}" }`));
      const plan = await inspect();
      const action = plan.actions[0]!;
      assert.equal(action.mode, 'create');
      assert.equal(action.review, true);
      const prepared = await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
      assert.deepEqual(prepared.request, { mode: 'suggested_create', ...action.expected });
      assert.deepEqual(await readCodexAutomations(codexHome), []);
      await assert.rejects(
        acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps()),
        rejectsCode('automation-review-pending'),
      );
      await assert.rejects(
        prepareCodexAutomation(pluginData, plan.digest, inputs(), deps()),
        rejectsCode('automation-plan-stale-or-blocked'),
      );
      await nativeWrite({ ...action.expected, rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0' });
      await assert.rejects(
        acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps()),
        rejectsCode('automation-readback-diverged'),
      );
      await nativeWrite(action.expected);
      await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps());
      assert.equal((await inspect()).status, 'aligned');
    });
  }

  it('should directly create supported local-time cron schedules', async () => {
    await manifest(job().replace('every 1 hour', '{ cron: "0 9 * * *" }'));
    const plan = await inspect();
    assert.equal(plan.actions[0]!.mode, 'create');
    assert.equal(plan.actions[0]!.review, undefined);
    const prepared = await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    assert.equal(prepared.request.mode, 'create');
    await nativeWrite(plan.actions[0]!.expected);
    await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps());
    assert.equal((await inspect()).status, 'aligned');
  });

  it('should directly create intervals and update timezone schedules in place', async () => {
    const zoned = (zone = 'America/New_York', hour = 9) =>
      job().replace('every 1 hour', `{ cron: "0 ${hour} * * *", timezone: "${zone}" }`);
    const initial = await inspect();
    assert.equal(initial.actions[0]!.mode, 'create');
    assert.equal(initial.actions[0]!.review, undefined);
    await syncOne();

    await manifest(zoned());
    const edit = await inspect();
    assert.equal(edit.actions[0]!.mode, 'update');
    assert.equal(edit.actions[0]!.review, undefined);
    assert.equal(edit.actions[0]!.id, 'fixture-native');
    const prepared = await prepareCodexAutomation(pluginData, edit.digest, inputs(), deps());
    assert.equal(prepared.request.mode, 'update');
    assert.equal(prepared.request.id, 'fixture-native');
    assert.equal(prepared.request.rrule, edit.actions[0]!.expected.rrule);
    assert.ok('projectId' in prepared.request);
    assert.equal(prepared.request.projectId, 'fixture-project');
    assert.equal(prepared.request.status, edit.actions[0]!.expected.status);
    await nativeWrite({ ...edit.actions[0]!.expected, rrule: 'FREQ=HOURLY;BYMINUTE=0' });
    await assert.rejects(
      acknowledgeCodexAutomation(pluginData, edit.digest, undefined, deps()),
      rejectsCode('automation-readback-diverged'),
    );
    await nativeWrite(edit.actions[0]!.expected);
    await acknowledgeCodexAutomation(pluginData, edit.digest, undefined, deps());
    assert.equal((await inspect()).status, 'aligned');
    const [saved] = await readCodexAutomations(codexHome);
    assert.equal(saved!.id, 'fixture-native');
    assert.equal(saved!.definition.rrule, edit.actions[0]!.expected.rrule);
    assert.ok(saved!.definition.kind === 'cron');
    assert.equal(saved!.definition.projectId, 'fixture-project');
    assert.equal(saved!.definition.status, edit.actions[0]!.expected.status);

    for (const declaration of [
      zoned('Europe/London'),
      zoned('UTC'),
      job().replace('every 1 hour', '{ cron: "0 9 * * *" }'),
    ]) {
      await manifest(declaration);
      const next = await inspect();
      assert.equal(next.actions[0]!.mode, 'update');
      assert.equal(next.actions[0]!.review, undefined);
      assert.equal(next.actions[0]!.id, 'fixture-native');
      await syncOne();
      assert.equal((await inspect()).status, 'aligned');
    }
  });

  it('should cancel a failed direct create only when no partial saved create exists', async () => {
    await manifest(job());
    const plan = await inspect();
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    await cancelCodexAutomation(pluginData, plan.digest, deps());
    assert.equal((await inspect()).status, 'requires-native-app-sync');
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    await nativeWrite({ ...plan.actions[0]!.expected, prompt: 'Reviewer removed the marker.' });
    await assert.rejects(
      cancelCodexAutomation(pluginData, plan.digest, deps()),
      rejectsCode('automation-cancel-recovery-required'),
    );
  });

  it('should enroll one coordinator-free pickup job and preserve its window anchor across pause and repeated installs', async () => {
    const provider = selectionFixture();
    await codexInstanceStore(pluginData).identity();
    const source = {
      'schema-version': 1,
      agent: { id: 'fixture' },
      models: {
        default: { model: 'openai/gpt-6-astra', effort: 'high' },
        low: { model: 'openai/gpt-6-luna', effort: 'medium' },
        medium: { model: 'openai/gpt-6.1-sol', effort: 'high' },
        high: { model: 'openai/gpt-6-astra', effort: 'high' },
      },
      github: {
        username: 'receiver',
        runtimes: ['codex'],
        routing: ['owner/*'],
        'issue-assignment': {
          model: 'medium',
          effort: 'low',
          mode: 'plan',
          allowed: [{ login: 'receiver', 'node-id': 'U_receiver' }],
        },
        'issue-pickup': {
          model: 'high',
          effort: 'minimal',
          paused: false,
          start: '10:00',
          window: '1 hour',
          scans: 1,
          projects: [
            { repository: 'owner/repo', milestone: { number: 10, policy: 'only' }, limit: 1 },
          ],
        },
      },
    };
    const saveManifest = () => writeFile(join(workspace, 'agent.yaml'), JSON.stringify(source));
    await saveManifest();
    const conversations = new Map<
      string,
      { id: string; name?: string; model?: string; effort?: string; archived?: boolean }
    >();
    const dependencies = {
      ...deps(),
      intake: { connect: async () => provider.client },
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
          const id = `pickup-thread-${conversations.size}`;
          await save(id);
          conversations.set(id, { id, ...settings });
          return id;
        },
        async updateSettings(
          current: { id: string },
          settings: { model?: string; effort?: string },
        ) {
          Object.assign(conversations.get(current.id)!, settings);
        },
        async rename(id: string, name: string) {
          conversations.get(id)!.name = name;
        },
      },
    };
    const reconcile = async () => {
      for (let index = 0; index < 4; index++) {
        const plan = await inspectCodexAutomations(pluginData, inputs(), dependencies);
        if (plan.status === 'aligned') return;
        assert.ok(plan.actions[0], JSON.stringify(plan));
        await syncOne(
          dependencies,
          `pickup-native-${(await readCodexAutomations(codexHome)).length}`,
        );
      }
      assert.fail('pickup installation did not converge');
    };
    // seed an installed old declaration; the native scheduler remains a fixture boundary.
    const legacySource = {
      ...source,
      github: { ...source.github, 'issue-pickup': undefined },
      automations: [
        {
          id: 'github-project-pickup',
          'display-name': '📥 PROJECT PICKUP',
          thread: 'PROJECT PICKUP',
          schedule: { cron: '0 10 * * *' },
          prompt: 'Previous pickup scan.',
          model: 'high',
          effort: 'minimal',
        },
      ],
    };
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(legacySource));
    const legacyPlan = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.notEqual(legacyPlan.status, 'blocked', JSON.stringify(legacyPlan));
    await syncThreads(dependencies);
    await reconcile();
    const legacyPickup = (await readCodexAutomations(codexHome)).find(
      ({ definition }) => definition.name === '📥 PROJECT PICKUP',
    )!;
    assert.ok(legacyPickup.definition.kind === 'heartbeat');
    const legacyChat = legacyPickup.definition.targetThreadId;
    const legacyHistory = structuredClone(conversations.get(legacyChat));
    await saveManifest();
    const enrollments = new IssuePickupEnrollmentStore(codexInstanceStore(pluginData).root);
    const priorEnrollment = await prepareCodexPickupEnrollment(pluginData, {
      ...dependencies.intake,
      codexHome,
    });
    await enrollments.activate(priorEnrollment.enrollment.id, legacyPickup.id);
    // an explicit shared target must respect the existing one-active-schedule guard.
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...source,
        github: {
          ...source.github,
          'issue-pickup': { ...source.github['issue-pickup'], thread: { id: legacyChat } },
        },
      }),
    );
    const sharedTarget = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    await syncCodexAutomationThreads(pluginData, sharedTarget.digest, inputs(), dependencies);
    const blocked = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
    assert.ok(
      blocked.findings.some(
        ({ id, code }) =>
          id === 'github-issue-pickup' && code === 'automation-thread-schedule-conflict',
      ),
      JSON.stringify(blocked),
    );
    await assert.rejects(
      prepareCodexAutomation(pluginData, blocked.digest, inputs(), dependencies),
      rejectsCode('automation-plan-stale-or-blocked'),
    );
    await nativeWrite({ ...legacyPickup.definition, status: 'PAUSED' }, legacyPickup.id);
    const ready = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.ok(!ready.findings.some(({ code }) => code === 'automation-thread-schedule-conflict'));
    await syncThreads(dependencies);
    const sameChat = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    const sameChatReplacement = sameChat.actions.find(
      ({ manifestId }) => manifestId === 'github-issue-pickup',
    )!;
    assert.equal(sameChatReplacement.mode, 'create');
    assert.ok(sameChatReplacement.expected.kind === 'heartbeat');
    assert.equal(sameChatReplacement.expected.targetThreadId, legacyChat);
    await nativeWrite({ ...legacyPickup.definition, status: 'ACTIVE' }, legacyPickup.id);
    await saveManifest();
    await syncThreads(dependencies);
    await reconcile();
    const installedPickup = (await readCodexAutomations(codexHome)).find(
      ({ definition }) => definition.name === '📥 ISSUE PICKUP',
    )!;
    assert.notEqual(installedPickup.id, legacyPickup.id);
    assert.ok(installedPickup.definition.kind === 'heartbeat');
    assert.notEqual(installedPickup.definition.targetThreadId, legacyChat);
    assert.equal(
      conversations.get(installedPickup.definition.targetThreadId)!.name,
      'ISSUE PICKUP',
    );
    assert.deepEqual(conversations.get(legacyChat), legacyHistory);
    assert.equal(
      (await readCodexAutomations(codexHome)).find(({ id }) => id === legacyPickup.id)!.definition
        .status,
      'PAUSED',
    );
    assert.equal(installedPickup.definition.rrule, legacyPickup.definition.rrule);
    assert.match(
      installedPickup.definition.prompt,
      /Managed by Agent System \(codex:[^:]+:github-issue-pickup\)\./u,
    );
    for (const { name, model, effort } of conversations.values())
      assert.deepEqual(
        { model, effort },
        name === 'ISSUE ASSIGNMENTS'
          ? { model: 'gpt-6.1-sol', effort: 'low' }
          : { model: 'gpt-6-astra', effort: 'minimal' },
      );
    const first = (await enrollments.read()).records[0]!;
    assert.deepEqual(first.enrollment, priorEnrollment.enrollment);
    let bindingReads = 0;
    const inspection = await inspectCodexAutomations(pluginData, inputs(), {
      ...dependencies,
      inspectBinding: async (root) => {
        bindingReads++;
        assert.equal(bindingReads, 1, 'planning must retain its selected binding');
        return inspectCodexWorkspaceBinding(root);
      },
    });
    assert.equal(inspection.status, 'aligned');
    assert.equal(bindingReads, 1);
    await unrelatedDamagedLedger();
    const active = await inspectCodexPickupActivation(pluginData, dependencies);
    assert.equal(active.nativeId, first.nativeId);
    await checkCodexActivationIsolation(
      codexHome,
      active.nativeId,
      () => inspectCodexPickupActivation(pluginData, dependencies),
      () => inspectCodexAutomations(pluginData, inputs(), dependencies),
    );
    assert.equal((await readCodexAutomations(codexHome)).length, 3);
    assert.equal(conversations.size, 3);
    await saveManifest();
    await reconcile();
    assert.deepEqual((await enrollments.read()).records, [first]);
    source.github['issue-pickup'].model = 'low';
    source.github['issue-pickup'].effort = 'high';
    await saveManifest();
    await syncThreads(dependencies);
    await reconcile();
    const pickupThread = [...conversations.values()].find(
      (thread) => thread.name === 'ISSUE PICKUP',
    )!;
    assert.equal(pickupThread.model, 'gpt-6-luna');
    assert.equal(pickupThread.effort, 'high');
    assert.deepEqual((await enrollments.read()).records, [first]);
    source.github['issue-pickup'].paused = true;
    await saveManifest();
    await reconcile();
    await assert.rejects(
      inspectCodexPickupActivation(pluginData, dependencies),
      rejectsCode('issue-pickup-paused'),
    );
    assert.deepEqual(await inspectCodexPickupActivation(pluginData, dependencies, true), active);

    source.github['issue-pickup'].paused = false;
    await saveManifest();
    await reconcile();
    assert.deepEqual(await inspectCodexPickupActivation(pluginData, dependencies), active);
    assert.deepEqual((await enrollments.read()).records, [first]);
    source.github['issue-pickup'].projects[0]!.limit = 3;
    source.github['issue-pickup'].projects[0]!.milestone.number = 11;
    provider.milestone.number = 11;
    provider.milestone.nodeId = 'MI_next';
    await saveManifest();
    const drift = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.equal(drift.status, 'aligned');
    assert.deepEqual(drift.actions, []);
    assert.deepEqual(await inspectCodexPickupActivation(pluginData, dependencies), active);
    await reconcile();
    const replacement = (await enrollments.read()).records[0]!;
    assert.equal(replacement.nativeId, first.nativeId);
    assert.deepEqual(replacement, first);
    assert.equal(replacement.enrollment.startedAt, first.enrollment.startedAt);
    assert.equal((await readCodexAutomations(codexHome)).length, 3);
    assert.equal(conversations.size, 3);
    const saved = (await readCodexAutomations(codexHome)).find(
      (job) => job.id === active.nativeId,
    )!;
    await nativeWrite({ ...saved.definition, rrule: 'FREQ=DAILY' }, saved.id);
    await assert.rejects(
      inspectCodexPickupActivation(pluginData, dependencies),
      rejectsCode('issue-pickup-automation-drift'),
    );
    await rm(join(codexHome, 'automations', saved.id), { recursive: true });
    await nativeWrite(saved.definition, 'copied-marker');
    await assert.rejects(
      inspectCodexPickupActivation(pluginData, dependencies),
      rejectsCode('issue-pickup-automation-drift'),
    );
    await rm(join(codexHome, 'automations', 'copied-marker'), { recursive: true });
    await nativeWrite({ ...saved.definition, status: 'PAUSED' }, saved.id);
    const resetBefore = await codexNotificationResetPickupAutomation(pluginData, dependencies);
    assert.ok(resetBefore && resetBefore.definition.kind === 'heartbeat');
    conversations.get(resetBefore.definition.targetThreadId)!.archived = true;
    await rm(join(codexHome, 'automations', saved.id), { recursive: true });
    const resetCreate = await replaceCoordinator(resetBefore, dependencies, 'github-issue-pickup');
    assert.ok(
      resetCreate.status === 'native-action' && resetCreate.request.tool === 'automation_update',
    );
    assert.equal(resetCreate.request.arguments.mode, 'create');
    const resetTarget = String(resetCreate.request.arguments.targetThreadId);
    await nativeWrite(
      { ...resetBefore.definition, targetThreadId: resetTarget },
      'pickup-replaced-native',
    );
    const resetDone = await replaceCoordinator(resetBefore, dependencies, 'github-issue-pickup');
    assert.equal(resetDone.status, 'done');
    const enrollmentAfterReset = (await enrollments.read()).records[0]!;
    assert.deepEqual(enrollmentAfterReset.enrollment, first.enrollment);
    assert.equal(enrollmentAfterReset.nativeId, 'pickup-replaced-native');
    assert.deepEqual(
      await replaceCoordinator(resetBefore, dependencies, 'github-issue-pickup'),
      resetDone,
    );
    assert.equal(
      (await codexNotificationResetPickupAutomation(pluginData, dependencies))?.definition.status,
      'PAUSED',
    );
    await rm(enrollments.path);
    assert.equal(
      (await replaceCoordinator(resetBefore, dependencies, 'github-issue-pickup')).status,
      'done',
    );
    assert.deepEqual((await enrollments.read()).records, []);
    await assert.rejects(
      replaceCoordinator(
        { ...resetBefore, definition: { ...resetBefore.definition, status: 'ACTIVE' } },
        dependencies,
        'github-issue-pickup',
      ),
      /issue-pickup-enrollment-missing/,
    );
  });

  it('should preserve intake on coordinator repair and retarget a reset only while paused', async () => {
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        'schema-version': 1,
        agent: { id: 'fixture' },
        models: {
          default: { model: 'openai/gpt-6-astra', effort: 'high' },
          low: { model: 'openai/gpt-6-luna', effort: 'medium' },
          medium: { model: 'openai/gpt-6.1-sol', effort: 'high' },
          high: { model: 'openai/gpt-6-astra', effort: 'high' },
        },
        github: {
          username: 'receiver',
          'schema-version': 3,
          runtimes: ['codex'],
          routing: ['owner/*'],
          'issue-assignment': {
            mode: 'plan',
            allowed: [{ login: 'receiver', 'node-id': 'U_receiver' }],
          },
        },
      }),
    );
    const conversations = new Map<
      string,
      { id: string; name?: string; archived?: boolean; model?: string; effort?: string }
    >();
    const provider = intakeFixture();
    provider.events.length = 0;
    let creates = 0;
    const dependencies = {
      ...deps(),
      intake: { connect: async () => provider.client },
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
          const id = `intake-${++creates}`;
          await save(id);
          conversations.set(id, { id, ...settings });
          return id;
        },
        async rename(id: string, name: string) {
          conversations.get(id)!.name = name;
        },
      },
    };
    const inspect = () => inspectCodexAutomations(pluginData, inputs(), dependencies);
    const binding = await inspectCodexWorkspaceBinding(pluginData);
    assert.ok(
      binding.status === 'bound' &&
        binding.preview.status === 'ready' &&
        binding.preview.manifest.status === 'loaded',
      JSON.stringify(binding),
    );
    await syncThreads(dependencies);
    async function reconcile() {
      for (let iteration = 0; iteration < 5; iteration++) {
        const plan = await inspect();
        if (plan.status === 'aligned') return;
        const action = plan.actions[0]!;
        assert.ok(action, JSON.stringify(plan.findings));
        await prepareCodexAutomation(pluginData, plan.digest, inputs(), dependencies);
        await nativeWrite(action.expected, action.id ?? `intake-job-${creates}-${iteration}`);
        await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, dependencies);
      }
      assert.fail('did not converge');
    }
    await reconcile();
    const before = await inspectCodexIntake(pluginData, dependencies);
    conversations.get('intake-1')!.archived = true;
    const first = await inspect();
    assert.ok(first.findings.some(({ code }) => code === 'automation-thread-replacement-required'));
    assert.equal(creates, 1);
    await syncThreads(dependencies);
    await reconcile();
    assert.equal(creates, 2);
    assert.equal(
      (await inspectCodexIntake(pluginData, dependencies)).baselineAt,
      before.baselineAt,
    );
    const saved = await codexNotificationResetAutomation(pluginData, dependencies);
    assert.equal(saved.definition.kind, 'heartbeat');
    conversations.get('intake-2')!.archived = true;
    await assert.rejects(
      replaceCoordinator(saved, dependencies),
      /notification-reset-automation-changed/u,
    );
    assert.equal(creates, 2);
    await nativeWrite({ ...saved.definition, status: 'PAUSED' }, saved.id);
    const effect = await replaceCoordinator(saved, dependencies);
    assert.equal(effect.status, 'native-action');
    assert.ok(effect.status === 'native-action' && effect.request.tool === 'automation_update');
    assert.equal(effect.request.arguments.status, 'PAUSED');
    const definition = {
      ...saved.definition,
      targetThreadId: 'intake-3',
      status: 'PAUSED' as const,
    };
    await nativeWrite(definition, saved.id);
    const completed = await replaceCoordinator(saved, dependencies);
    assert.equal(completed.status, 'done');
    assert.equal(creates, 3);
    const updated = JSON.parse(completed.automation!);
    assert.equal(updated.definition.targetThreadId, 'intake-3');
    assert.equal(updated.definition.status, 'ACTIVE');
    await nativeWrite(updated.definition, saved.id);
    assert.equal((await inspect()).status, 'aligned');

    // desktop archival removes the heartbeat; recovery must create once and adopt exact readback.
    const retained = await codexNotificationResetAutomation(pluginData, dependencies);
    conversations.get('intake-3')!.archived = true;
    await rm(join(codexHome, 'automations', saved.id), { recursive: true });
    const replacement = await replaceCoordinator(retained, dependencies);
    assert.equal(replacement.status, 'native-action');
    assert.ok(
      replacement.status === 'native-action' && replacement.request.tool === 'automation_update',
    );
    assert.equal(replacement.request.arguments.mode, 'create');
    assert.equal(replacement.request.arguments.status, 'PAUSED');
    assert.equal(creates, 4);
    assert.deepEqual(await replaceCoordinator(retained, dependencies), replacement);
    assert.equal(creates, 4);
    const replacementDefinition = {
      ...retained.definition,
      targetThreadId: 'intake-4',
      status: 'PAUSED' as const,
    };
    await nativeWrite({ ...replacementDefinition, rrule: 'FREQ=DAILY' }, 'replacement');
    await assert.rejects(
      replaceCoordinator(retained, dependencies),
      /notification-reset-automation-changed/u,
    );
    await nativeWrite(replacementDefinition, 'replacement');
    await nativeWrite(replacementDefinition, 'duplicate');
    await assert.rejects(
      replaceCoordinator(retained, dependencies),
      /notification-reset-automation-changed/u,
    );
    await rm(join(codexHome, 'automations', 'duplicate'), { recursive: true });
    const recovered = await replaceCoordinator(retained, dependencies);
    assert.equal(recovered.status, 'done');
    const replacementSaved = JSON.parse(recovered.automation!);
    assert.equal(replacementSaved.id, 'replacement');
    assert.equal(replacementSaved.definition.status, 'ACTIVE');
    assert.deepEqual(await replaceCoordinator(retained, dependencies), recovered);
    assert.equal(creates, 4);
    await nativeWrite(replacementSaved.definition, replacementSaved.id);
    assert.equal((await inspect()).status, 'aligned');
    assert.equal(
      (await inspectCodexIntake(pluginData, dependencies)).baselineAt,
      before.baselineAt,
    );
  });

  it('should create per-automation conversations and migrate only after retiring the old active schedule', async () => {
    await syncOne();
    const conversations = new Map<string, { id: string; name?: string }>();
    let creates = 0;
    const dependencies = {
      ...deps(),
      threadAdapter: {
        async lookup(id: string) {
          return conversations.get(id) ?? null;
        },
        async create(_record: unknown, save: (id: string) => Promise<void>) {
          const id = `thread-${++creates}`;
          await save(id);
          conversations.set(id, { id });
          return id;
        },
        async rename(id: string, name: string) {
          conversations.set(id, { id, name });
        },
      },
    };
    await manifest(job('    thread: { id: activity, name: Activity }\n'));
    const before = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.equal(before.status, 'requires-native-app-sync');
    await syncThreads(dependencies);
    const migration = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.equal(migration.actions[0]?.retire, true);
    assert.equal(migration.actions[0]?.expected.status, 'PAUSED');
    const prepared = await prepareCodexAutomation(
      pluginData,
      migration.digest,
      inputs(),
      dependencies,
    );
    await nativeWrite(migration.actions[0]!.expected);
    await acknowledgeCodexAutomation(pluginData, prepared.digest, undefined, dependencies);
    const replacement = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.equal(replacement.actions[0]?.mode, 'create');
    assert.equal(replacement.actions[0]?.expected.kind, 'heartbeat');
    await prepareCodexAutomation(pluginData, replacement.digest, inputs(), dependencies);
    await nativeWrite(replacement.actions[0]!.expected, 'replacement');
    await acknowledgeCodexAutomation(pluginData, replacement.digest, undefined, dependencies);
    assert.equal(
      (await inspectCodexAutomations(pluginData, inputs(), dependencies)).status,
      'aligned',
    );
    assert.equal(creates, 1);
    assert.equal(
      (await readCodexAutomations(codexHome)).filter((item) => item.definition.status === 'ACTIVE')
        .length,
      1,
    );
    assert.equal((await readCodexAutomations(codexHome)).length, 2);
    const beforeRename = (await readCodexAutomations(codexHome)).find(
      ({ id }) => id === 'replacement',
    )!;
    assert.equal(beforeRename.definition.name, 'fixture: review');
    for (const [label, expectedName] of [
      ['🔄 NIGHTLY REFRESH', 'NIGHTLY REFRESH'],
      ['🔄 RENAMED', 'RENAMED'],
      [undefined, 'FIXTURE: REVIEW'],
    ]) {
      await manifest(
        job(
          `    thread: { id: activity, name: Activity }\n${label ? `    display-name: "${label}"\n` : ''}`,
        ),
      );
      const plan = await inspectCodexAutomations(pluginData, inputs(), dependencies);
      const action = plan.actions[0]!;
      assert.equal(plan.actions.length, 1);
      assert.equal(action.mode, 'update');
      assert.equal(action.id, 'replacement');
      assert.deepEqual(action.expected, {
        ...beforeRename.definition,
        name: label ?? 'fixture: review',
      });
      await prepareCodexAutomation(pluginData, plan.digest, inputs(), dependencies);
      await nativeWrite(action.expected, action.id);
      await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, dependencies);
      const readback = await inspectCodexAutomations(pluginData, inputs(), dependencies);
      assert.equal(readback.status, 'aligned');
      assert.equal(
        readback.findings.find(({ id }) => id === 'review')?.automationName,
        expectedName,
      );
      assert.equal(creates, 1);
      assert.deepEqual([...conversations.values()], [{ id: 'thread-1', name: 'Activity' }]);
      assert.equal((await readCodexAutomations(codexHome)).length, 2);
    }
  });

  for (const failure of ['busy', 'denied', 'uncertain', 'conflict', 'unreadable'] as const) {
    it(`should isolate only a safe pending model change from schedule sync: ${failure}`, async () => {
      const declaration = (model: string, interval: number) =>
        job(
          `    thread: {name: Review}\n    overrides:\n      codex: {model: ${model}, effort: high}\n`,
        ).replace('every 1 hour', `every ${interval} hours`) +
        job().replace('id: review', 'id: peer').replace('every 1 hour', `every ${interval} hours`);
      await manifest(declaration('original', 1));
      let current: AutomationThread | null = null;
      let writes = 0;
      const adapter: AutomationThreadAdapter = {
        async lookup() {
          return current;
        },
        async create(_record, save, _fresh, settings) {
          await save('thread-1');
          current = { id: 'thread-1', incarnation: 'original', ...settings };
          return 'thread-1';
        },
        async rename(_id, name) {
          current!.name = name;
        },
        async updateSettings() {
          writes++;
          if (failure === 'conflict') current!.incarnation = 'different';
          if (failure === 'unreadable') current = null;
          if (failure === 'uncertain') throw new Error('connection lost');
          throw new AutomationError(
            `automation-thread-settings-${failure === 'denied' ? 'denied' : 'busy'}`,
          );
        },
      };
      const dependencies = { ...deps(), threadAdapter: adapter };
      await syncThreads(dependencies);
      await syncOne(dependencies, 'review-native');
      await syncOne(dependencies, 'peer-native');
      await manifest(declaration('desired', 2));
      const drift = await inspectCodexAutomations(pluginData, inputs(), dependencies);
      assert.equal(drift.actions.length, 2);
      assert.equal(writes, 0);
      await assert.rejects(
        syncCodexAutomationThreads(pluginData, drift.digest, inputs(), dependencies),
      );
      assert.equal(writes, 1);
      const pending = await inspectCodexAutomations(pluginData, inputs(), dependencies);
      if (failure !== 'busy') {
        assert.deepEqual(pending.actions, []);
        await assert.rejects(
          prepareCodexAutomation(pluginData, pending.digest, inputs(), dependencies),
        );
        assert.equal(writes, 1);
        return;
      }
      assert.equal(pending.actions.length, 2);
      assert.deepEqual(
        pending.findings.find(({ code }) => code === 'automation-thread-settings-busy')?.settings,
        {
          requested: { model: 'desired', effort: 'high' },
          observed: { model: 'original', effort: 'high' },
        },
      );
      await syncOne(dependencies);
      await syncOne(dependencies);
      const synced = await inspectCodexAutomations(pluginData, inputs(), dependencies);
      assert.deepEqual(synced.actions, []);
      assert.equal(synced.status, 'requires-native-app-sync');
      assert.ok(synced.findings.some(({ code }) => code === 'automation-thread-settings-busy'));
      assert.equal(writes, 1);
      assert.equal(current!.model, 'original');
      assert.ok(
        (await readCodexAutomations(codexHome)).every(({ definition }) =>
          definition.rrule.includes('INTERVAL=2'),
        ),
      );
      current!.model = 'desired';
      await syncThreads(dependencies);
      assert.equal(
        (await inspectCodexAutomations(pluginData, inputs(), dependencies)).status,
        'aligned',
      );
      assert.equal(writes, 1);
    });
  }

  it('should prepare one native settings turn for an idle owned chat and reconcile without replay', async () => {
    const declaration = (model: string) =>
      job(
        `    thread: {name: Review}\n    overrides:\n      codex: {model: ${model}, effort: high}\n`,
      );
    await manifest(declaration('original'));
    let current: AutomationThread | null = null;
    let writes = 0,
      creates = 0;
    const adapter: AutomationThreadAdapter = {
      async lookup() {
        return current;
      },
      async create(_record, save, _fresh, settings) {
        creates++;
        await save('thread-1');
        current = { id: 'thread-1', incarnation: 'original', ...settings };
        return 'thread-1';
      },
      async rename(_id, name) {
        current!.name = name;
      },
      async updateSettings() {
        writes++;
        throw new AutomationError('automation-thread-settings-busy');
      },
    };
    const dependencies = { ...deps(), threadAdapter: adapter };
    await syncThreads(dependencies);
    await syncOne(dependencies);
    await manifest(declaration('desired'));
    const drift = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    await assert.rejects(
      syncCodexAutomationThreads(pluginData, drift.digest, inputs(), dependencies),
      rejectsCode('automation-thread-verification-required'),
    );
    assert.equal(writes, 1);
    const nativeInput = (status: string) => ({
      ...inputs(),
      threads: [
        {
          schemaVersion: 1,
          thread: {
            id: 'thread-1',
            kind: 'codex',
            hostId: 'local',
            cwd: workspace,
            status: { type: status },
          },
        },
      ],
    });
    const pending = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    await assert.rejects(
      syncCodexAutomationThreads(pluginData, pending.digest, nativeInput('active'), dependencies),
      rejectsCode('automation-thread-settings-busy'),
    );
    assert.equal(writes, 1);
    const effect = await syncCodexAutomationThreads(
      pluginData,
      pending.digest,
      nativeInput('idle'),
      dependencies,
    );
    assert.equal(effect.status, 'native-action');
    assert.ok('request' in effect && effect.request.tool === 'send_message_to_thread');
    assert.equal(effect.request.arguments.threadId, 'thread-1');
    assert.equal(effect.request.arguments.model, 'desired');
    assert.equal(effect.request.arguments.thinking, 'high');
    assert.equal(effect.request.arguments.hostId, 'local');
    assert.match(effect.request.arguments.prompt, /configuration-only/u);
    assert.match(effect.request.arguments.prompt, /Do not invoke tools/u);
    const uncertain = await inspectCodexAutomations(pluginData, nativeInput('idle'), dependencies);
    assert.ok(
      uncertain.findings.some(({ code }) => code === 'automation-thread-settings-uncertain'),
    );
    await assert.rejects(
      syncCodexAutomationThreads(pluginData, uncertain.digest, nativeInput('idle'), dependencies),
    );
    assert.equal(writes, 1);
    current!.model = 'desired';
    const converged = await inspectCodexAutomations(pluginData, nativeInput('idle'), dependencies);
    assert.equal(converged.status, 'aligned');
    assert.equal(
      (
        await syncCodexAutomationThreads(
          pluginData,
          converged.digest,
          nativeInput('idle'),
          dependencies,
        )
      ).status,
      'verified',
    );
    const repeated = await inspectCodexAutomations(pluginData, nativeInput('idle'), dependencies);
    assert.equal(repeated.status, 'aligned');
    assert.deepEqual(repeated.actions, []);
    assert.equal(
      (
        await syncCodexAutomationThreads(
          pluginData,
          repeated.digest,
          nativeInput('idle'),
          dependencies,
        )
      ).status,
      'verified',
    );
    assert.equal(writes, 1);
    assert.equal(creates, 1);
  });

  it('should identify settings and thread failures while retaining full read-only codex evidence', async () => {
    await manifest(
      job(
        '    thread: {name: Review}\n    overrides:\n      codex: {model: selected, effort: high}\n',
      ),
    );
    const conversations = new Map<string, AutomationThread>();
    const adapter: AutomationThreadAdapter = {
      async lookup(id) {
        return conversations.get(id) ?? null;
      },
      async create(_record, save, _fresh, settings) {
        await save('thread-1');
        conversations.set('thread-1', { id: 'thread-1', ...settings });
        return 'thread-1';
      },
      async rename(id, name) {
        conversations.get(id)!.name = name;
      },
      async updateSettings() {
        assert.fail('inspection must not change settings');
      },
    };
    const dependencies = { ...deps(), threadAdapter: adapter };
    await syncThreads(dependencies);
    const current = conversations.get('thread-1')!;
    const plan = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), dependencies);
    await nativeWrite(plan.actions[0]!.expected);
    await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, dependencies);
    const healthy = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.equal(healthy.status, 'aligned');
    assert.ok(
      healthy.findings.some(({ id, code }) => id === 'review' && code === 'automation-healthy'),
    );
    assert.equal(
      healthy.findings.find(({ id }) => id === 'review')?.automationName,
      'FIXTURE: REVIEW',
    );
    assert.deepEqual(healthy.conversations?.[0]?.settings, {
      requested: { model: 'selected', effort: 'high' },
      observed: { model: 'selected', effort: 'high' },
    });
    const saved = await readCodexAutomations(codexHome);
    for (const dimension of ['model', 'effort'] as const) {
      current[dimension] = 'different';
      const drift = await inspectCodexAutomations(pluginData, inputs(), dependencies);
      const finding = drift.findings.find(({ code }) => code === 'automation-thread-model-drift');
      assert.equal(finding?.id, 'review');
      assert.equal(finding?.automationName, 'FIXTURE: REVIEW');
      assert.deepEqual(finding?.settings, {
        requested: { model: 'selected', effort: 'high' },
        observed: { model: 'selected', effort: 'high', [dimension]: 'different' },
      });
      assert.equal(drift.status, 'requires-native-app-sync');
      assert.deepEqual(drift.actions, []);
      assert.equal(current[dimension], 'different');
      current[dimension] = dimension === 'model' ? 'selected' : 'high';
    }
    adapter.validateSettings = async () => {
      throw new AutomationError('automation-model-unsupported');
    };
    const unsupported = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.equal(unsupported.status, 'blocked');
    assert.ok(
      unsupported.findings.some(
        ({ id, code, settings }) =>
          id === 'review' &&
          code === 'automation-model-unsupported' &&
          settings?.requested.model === 'selected',
      ),
    );
    delete adapter.validateSettings;
    current.name = 'Other';
    const failed = await inspectCodexAutomations(pluginData, inputs(), dependencies);
    assert.ok(
      failed.findings.some(
        ({ id, code }) => id === 'review' && code === 'automation-thread-name-drift',
      ),
    );
    assert.deepEqual(await readCodexAutomations(codexHome), saved);
    assert.equal(conversations.size, 1);
  });

  it('should list owned state through the planner and report native occurrence gaps without writes', async () => {
    const before = await readdir(pluginData);
    const initial = await listCodexAutomations(pluginData, inputs(), deps());
    assert.equal(initial.jobs[0]!.nativeId, null);
    assert.equal(initial.status, 'requires-native-app-sync');
    const gap = await codexAutomationRunGap(pluginData, 'review', 'run', deps());
    assert.equal(gap.code, 'automation-run-now-unsupported');
    assert.equal(gap.manualTask!.schedulerOccurrence, false);
    assert.equal(gap.manualTask!.consumesOneShot, false);
    assert.deepEqual(await readdir(pluginData), before);
    await assert.rejects(
      codexAutomationRunGap(pluginData, 'missing', 'run', deps()),
      rejectsCode('automation-id-missing'),
    );
    await syncOne();
    const listed = await listCodexAutomations(pluginData, inputs(), deps());
    assert.equal(listed.jobs[0]!.nativeId, 'fixture-native');
    assert.equal(listed.jobs[0]!.nativeStatus, 'ACTIVE');
    assert.equal(
      (await codexAutomationRunGap(pluginData, 'review', 'runs', deps())).code,
      'automation-history-unavailable',
    );
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

  it('should activate a new job independently of pausing a removed job', async () => {
    await syncOne();
    await manifest(job().replace('id: review', 'id: update'));
    const plan = await inspect();
    const prepared = await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    assert.equal(prepared.request.mode, 'create');
    assert.equal(prepared.request.status, 'ACTIVE');
    await nativeWrite(plan.actions[0]!.expected, 'replacement');
    await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps());
    const pause = await inspect();
    assert.equal(pause.actions.length, 1);
    assert.equal(pause.actions[0]!.id, 'fixture-native');
    assert.equal(pause.actions[0]!.expected.status, 'PAUSED');
    await syncOne();
    assert.equal((await inspect()).status, 'aligned');
    assert.equal(
      (await readCodexAutomations(codexHome)).find(({ id }) => id === 'replacement')!.definition
        .status,
      'ACTIVE',
    );
  });

  for (const status of ['active', 'paused']) {
    it(`should retire a deleted ${status} job through fresh automation sync after setup and retain its history`, async () => {
      await syncOne();
      const [old] = await readCodexAutomations(codexHome);
      if (status === 'paused') {
        await manifest('');
        await syncOne();
      }
      const dependencies = { ...deps(), automationInputs: inputs(), now: () => 1234 };
      const before = await ownership();
      await manifest(job().replace('id: review', 'id: update'));
      await rm(join(codexHome, 'automations', 'fixture-native', 'automation.toml'));
      for (const name of ['.run-jitter-salt', 'unrelated-file'])
        await writeFile(join(codexHome, 'automations', name), 'not an automation definition');
      const plan = await inspect();
      assert.ok(plan.findings.some(({ code }) => code === 'automation-retirement-pending'));
      assert.deepEqual(plan.actions, []);
      assert.equal(
        (await inspectCodexSetup(pluginData, undefined, dependencies)).automations.status,
        'blocked',
      );
      assert.equal((await ownership()).bytes, before.bytes);
      const installed = await installCodexSetup(pluginData, undefined, dependencies);
      assert.equal(installed.automations.status, 'requires-fresh-inspection');
      assert.equal((await ownership()).bytes, before.bytes);
      await reconcileCodexAutomationRetirements(pluginData, dependencies);
      assert.equal((await inspect()).actions[0]!.manifestId, 'update');
      const retired = await ownership();
      assert.deepEqual(retired.ledger.records[0], {
        ...before.ledger.records[0],
        removed: true,
        retired: { atMs: 1234, reason: 'native-job-absent' },
      });
      await syncOne(deps(), 'replacement');
      const final = await ownership();
      assert.equal(
        (await inspectCodexSetup(pluginData, undefined, dependencies)).automations.status,
        'aligned',
      );
      assert.equal(
        (await installCodexSetup(pluginData, undefined, dependencies)).automations.status,
        'requires-fresh-inspection',
      );
      assert.equal((await ownership()).bytes, final.bytes);
      assert.equal((await readCodexAutomations(codexHome)).length, 1);
      const history = (await listCodexAutomations(pluginData, inputs(), deps())).jobs.find(
        ({ id }) => id === 'review',
      )!;
      assert.equal(history.retired, true);
      assert.equal(history.nativeId, 'fixture-native');
      assert.equal(history.nativeStatus, null);
      await manifest();
      const reuse = await inspect();
      assert.equal(reuse.status, 'blocked');
      assert.ok(reuse.findings.some(({ code }) => code === 'automation-retired-id'));
      await manifest('');
      for (const id of ['fixture-native', 'imposter']) {
        await nativeWrite(old!.definition, id);
        await assert.rejects(inspect(), rejectsCode('automation-ownership-conflict'));
        assert.equal((await ownership()).bytes, final.bytes);
        await rm(join(codexHome, 'automations', id, 'automation.toml'));
      }
    });
  }

  for (const obstruction of [
    'missing-root',
    'symlink',
    'unreadable',
    'reappeared',
    'manifest-changed',
    'ownership-changed',
  ]) {
    it(`should preserve deletion evidence when retirement inspection is ${obstruction}`, async () => {
      await syncOne();
      const [old] = await readCodexAutomations(codexHome);
      await manifest(job().replace('id: review', 'id: update'));
      await rm(join(codexHome, 'automations', 'fixture-native', 'automation.toml'));
      const before = await ownership();
      if (obstruction === 'missing-root')
        await rm(join(codexHome, 'automations'), { recursive: true });
      if (obstruction === 'symlink')
        await symlink(workspace, join(codexHome, 'automations', 'link'));
      if (obstruction === 'unreadable') {
        await mkdir(join(codexHome, 'automations', 'unknown'));
        await writeFile(
          join(codexHome, 'automations', 'unknown', 'automation.toml'),
          'version = 99',
        );
      }
      let reads = 0;
      let concurrentBytes = before.bytes;
      await assert.rejects(
        reconcileCodexAutomationRetirements(pluginData, {
          ...deps(),
          async readAutomations(home, options) {
            assert.equal(options?.requireComplete, true);
            reads++;
            if (reads === 2 && obstruction === 'reappeared') await nativeWrite(old!.definition);
            if (reads === 2 && obstruction === 'manifest-changed') await manifest();
            if (reads === 2 && obstruction === 'ownership-changed') {
              before.ledger.records[0].removed = true;
              concurrentBytes = JSON.stringify(before.ledger);
              await writeFile(before.path, concurrentBytes);
            }
            return readCodexAutomations(home, options);
          },
        }),
      );
      assert.equal((await ownership()).bytes, concurrentBytes);
      assert.equal((await ownership()).ledger.records[0].retired, undefined);
    });
  }

  for (const pending of ['old-pause', 'other-create']) {
    it(`should refuse deletion retirement while ${pending} remains unresolved`, async () => {
      await syncOne();
      if (pending === 'old-pause') await manifest('');
      else await manifest(job() + job().replace('id: review', 'id: update'));
      const plan = await inspect();
      await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
      await manifest(job().replace('id: review', 'id: update'));
      await rm(join(codexHome, 'automations', 'fixture-native', 'automation.toml'));
      const before = await ownership();
      await reconcileCodexAutomationRetirements(pluginData, deps());
      assert.equal((await ownership()).bytes, before.bytes);
    });
  }

  it('should keep declared missing jobs in explicit recovery rather than retire or recreate them', async () => {
    await syncOne();
    await rm(join(codexHome, 'automations', 'fixture-native', 'automation.toml'));
    const before = await ownership();
    await reconcileCodexAutomationRetirements(pluginData, deps());
    const plan = await inspect();
    assert.equal(plan.status, 'blocked');
    assert.deepEqual(plan.actions, []);
    assert.ok(plan.findings.some(({ code }) => code === 'automation-native-recovery-required'));
    assert.equal((await ownership()).bytes, before.bytes);
  });

  it('should reject retirement ownership conflicts without adopting matching names', async () => {
    await syncOne();
    const [old] = await readCodexAutomations(codexHome);
    await manifest(job().replace('id: review', 'id: update'));
    await nativeWrite({ ...old!.definition, prompt: 'unmanaged' });
    const before = await ownership();
    await assert.rejects(
      reconcileCodexAutomationRetirements(pluginData, deps()),
      rejectsCode('automation-ownership-conflict'),
    );
    assert.equal((await ownership()).bytes, before.bytes);
  });

  it('should retain heartbeat history after retiring a deleted job', async () => {
    const conversations = new Map<string, { id: string; name?: string }>();
    const dependencies = {
      ...deps(),
      threadAdapter: {
        async lookup(id: string) {
          return conversations.get(id) ?? null;
        },
        async create(_record: unknown, save: (id: string) => Promise<void>) {
          const id = `thread-${conversations.size}`;
          await save(id);
          conversations.set(id, { id });
          return id;
        },
        async rename(id: string, name: string) {
          conversations.set(id, { id, name });
        },
      },
    };
    const declaration = (id: string) =>
      job('    thread: { name: Activity }\n').replace('id: review', `id: ${id}`);
    await manifest(declaration('nightly-refresh'));
    await syncThreads(dependencies);
    await syncOne(dependencies, 'old');
    const old = (await readCodexAutomations(codexHome))[0]!.definition;
    assert.equal(old.kind, 'heartbeat');
    await manifest(declaration('update'));
    await syncThreads(dependencies);
    const history = structuredClone(conversations.get('thread-0'));
    await rm(join(codexHome, 'automations', 'old', 'automation.toml'));
    await reconcileCodexAutomationRetirements(pluginData, dependencies);
    await syncOne(dependencies, 'replacement');
    const replacement = (await readCodexAutomations(codexHome)).find(
      ({ id }) => id === 'replacement',
    )!.definition;
    assert.equal(replacement.status, 'ACTIVE');
    assert.equal(replacement.kind, 'heartbeat');
    assert.notEqual(replacement.targetThreadId, old.targetThreadId);
    assert.deepEqual(conversations.get('thread-0'), history);
    assert.equal(conversations.size, 2);
    assert.equal(
      (await inspectCodexAutomations(pluginData, inputs(), dependencies)).status,
      'aligned',
    );
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
    await appendFile(
      join(workspace, 'agent.yaml'),
      '\nmodels:\n  default:\n    model: openai/default\n    effort: high\n',
    );
    assert.equal((await inspect()).findings[0]?.code, 'automation-thread-verification-required');
    assert.ok(
      (await inspect()).findings
        .filter(({ code }) => code === 'automation-thread-verification-required')
        .every(({ id }) => id === 'review'),
    );
    const threads = [
      JSON.parse((await capture('lookups')).replaceAll('/workspace/fixture', workspace)).thread,
    ];
    nativeInventory.sections.push({
      sectionId: 'existing-section',
      name: 'AGENT SYSTEM',
      itemKeys: ['codex:thread:local:fixture-thread'],
    });
    const plan = await inspectCodexAutomations(pluginData, { ...inputs(), threads }, deps());
    assert.equal(plan.actions[0]?.expected.kind, 'heartbeat');
    await syncCodexAutomationThreads(pluginData, plan.digest, { ...inputs(), threads }, deps());
    nativeInventory.sections.push({
      sectionId: 'later-duplicate',
      name: 'AGENT SYSTEM',
      itemKeys: [],
    });
    const retained = await inspectCodexAutomations(pluginData, { ...inputs(), threads }, deps());
    assert.equal(
      retained.actions[0]?.expected.kind,
      'heartbeat',
      JSON.stringify(retained.findings),
    );
    await manifest(
      job(
        '    overrides:\n      codex:\n        model: gpt-6-astra\n        target: {thread: fixture-thread}\n',
      ),
    );
    assert.equal((await inspect()).findings[0]?.code, 'automation-thread-settings-unowned');
  });

  it('should move an explicit chat after a group change without rewriting its schedule', async () => {
    const target =
      '    runtimes: [codex]\n    overrides:\n      codex:\n        target: {thread: fixture-thread}\n';
    await manifest(job(target));
    nativeInventory.sections.push({
      sectionId: 'default',
      name: 'AGENT SYSTEM',
      itemKeys: ['codex:thread:local:fixture-thread'],
    });
    const threads = [
      JSON.parse((await capture('lookups')).replaceAll('/workspace/fixture', workspace)).thread,
    ];
    const lookup = () => ({ ...inputs(), threads });
    const plan = await inspectCodexAutomations(pluginData, lookup(), deps());
    await prepareCodexAutomation(pluginData, plan.digest, lookup(), deps());
    await nativeWrite(plan.actions[0]!.expected);
    await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps());
    const before = await readCodexAutomations(codexHome);
    await manifest(job(target + '    group: operations\n'));
    for (let i = 0; i < 3; i++) {
      const current = await inspectCodexAutomations(pluginData, lookup(), deps());
      assert.ok(current.findings.some(({ code }) => code === 'automation-thread-group-drift'));
      const effect = await syncCodexAutomationThreads(pluginData, current.digest, lookup(), deps());
      if (i < 2) assert.ok(applySidebar(effect), JSON.stringify(effect));
      else assert.equal(effect.status, 'verified');
    }
    assert.equal((await inspectCodexAutomations(pluginData, lookup(), deps())).status, 'aligned');
    assert.deepEqual(await readCodexAutomations(codexHome), before);
    assert.deepEqual(nativeInventory.sections.find(({ name }) => name === 'OPERATIONS')!.itemKeys, [
      'codex:thread:local:fixture-thread',
    ]);
    assert.deepEqual(nativeInventory.sections[0]!.itemKeys, []);
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

  it('should reject wrong receipts and acknowledge the prepared write after valid manifest edits', async () => {
    const plan = await inspect();
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    await nativeWrite(plan.actions[0]!.expected);
    const native = JSON.parse(await capture('native'));
    await assert.rejects(
      acknowledgeCodexAutomation(pluginData, plan.digest, native.create.response, deps()),
      rejectsCode('automation-readback-diverged'),
    );
    await manifest(job().replace('Review this workspace.', 'Changed prompt.'));
    await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps());
    const next = await inspect();
    assert.equal(next.status, 'requires-native-app-sync');
    assert.equal(next.actions[0]?.mode, 'update');
    assert.equal(next.actions[0]?.id, 'fixture-native');
    assert.match(next.actions[0]!.expected.prompt, /Changed prompt/u);
  });

  it('should recover successful writes despite unrelated edits and manifest comments', async () => {
    const unrelated = parseSavedAutomation(
      await capture('project'),
      'agent-system-196-paused-fixture',
    ).definition;
    await nativeWrite(unrelated, 'personal');
    const plan = await inspect();
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    await nativeWrite(plan.actions[0]!.expected);
    await nativeWrite({ ...unrelated, prompt: 'An edited personal task.' }, 'personal');
    await writeFile(
      join(workspace, 'agent.yaml'),
      (await readFile(join(workspace, 'agent.yaml'), 'utf8')) + '\n# unrelated comment\n',
    );
    await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps());
    assert.equal((await inspect()).status, 'aligned');
    assert.equal(
      (await readCodexAutomations(codexHome)).find((item) => item.id === 'personal')?.definition
        .prompt,
      'An edited personal task.',
    );
  });

  it('should cancel failed creates and updates despite unrelated edits', async () => {
    const unrelated = parseSavedAutomation(
      await capture('project'),
      'agent-system-196-paused-fixture',
    ).definition;
    await nativeWrite(unrelated, 'personal');
    for (const mode of ['create', 'update']) {
      const plan = await inspect();
      assert.equal(plan.actions[0]?.mode, mode);
      await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
      await nativeWrite({ ...unrelated, prompt: `Personal edit during ${mode}.` }, 'personal');
      await cancelCodexAutomation(pluginData, plan.digest, deps());
      assert.equal((await inspect()).status, 'requires-native-app-sync');
      await syncOne();
      await manifest(job().replace('Review this workspace.', 'Updated review.'));
    }
  });

  it('should retain pending creates when an unattributed native job appears', async () => {
    const plan = await inspect();
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    await nativeWrite({
      ...plan.actions[0]!.expected,
      prompt: 'A truncated prompt without its marker.',
    });
    await assert.rejects(
      cancelCodexAutomation(pluginData, plan.digest, deps()),
      rejectsCode('automation-cancel-recovery-required'),
    );
    assert.equal((await inspect()).status, 'blocked');
  });

  it('should recover older pending journals without discarding their ownership state', async () => {
    for (const completed of [false, true]) {
      const plan = await inspect();
      const before = await readCodexAutomations(codexHome);
      await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
      const name = (await readdir(pluginData)).find((name) =>
        name.startsWith('codex-automations-'),
      )!;
      const path = join(pluginData, name);
      const ledger = JSON.parse(await readFile(path, 'utf8'));
      delete ledger.pending.targetBefore;
      ledger.pending.beforeHash = automationHash(before);
      ledger.pending.othersHash = automationHash(before);
      await writeFile(path, JSON.stringify(ledger));
      if (completed) {
        await nativeWrite(plan.actions[0]!.expected);
        await manifest(job().replace('Review this workspace.', 'Updated review.'));
        await acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps());
      } else await cancelCodexAutomation(pluginData, plan.digest, deps());
      assert.equal((await inspect()).status, 'requires-native-app-sync');
    }
  });

  it('should retain pending updates when their target changes or its marker is duplicated', async () => {
    await syncOne();
    await manifest(job().replace('Review this workspace.', 'Updated review.'));
    const plan = await inspect();
    await prepareCodexAutomation(pluginData, plan.digest, inputs(), deps());
    await nativeWrite({ ...plan.actions[0]!.expected, prompt: 'A divergent target.' });
    await assert.rejects(
      cancelCodexAutomation(pluginData, plan.digest, deps()),
      rejectsCode('automation-cancel-recovery-required'),
    );
    await nativeWrite(plan.actions[0]!.expected);
    await nativeWrite(
      {
        ...plan.actions[0]!.expected,
        prompt: `${plan.actions[0]!.expected.prompt}\nCopied marker.`,
      },
      'duplicate',
    );
    await assert.rejects(
      acknowledgeCodexAutomation(pluginData, plan.digest, undefined, deps()),
      rejectsCode('automation-readback-diverged'),
    );
  });
});
