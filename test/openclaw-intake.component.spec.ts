import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import installAgentSystem from '../cli/install.ts';
import { getCliDiagnosticContext } from '../core/cli-diagnostic-context.ts';
import { createCliStyles } from '../cli/output.ts';
import OpenClawNotifications from '../agent/openclaw-notifications.ts';
import notificationStatus from '../channels/github/cli/status.ts';
import notificationWait from '../channels/github/cli/wait.ts';
import assignmentIntakePolicy from '../agent/assignment-intake-policy.ts';
import { codexIntakePolicy } from '../agent/codex-intake-policy.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import AgentDoctorService from '../agent/doctor-service.ts';
import doctorAgentSystem from '../cli/doctor.ts';
import AgentSystemLifecycleRegistry from '../core/lifecycle-registry.ts';
import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
import { automationPatch, projectAutomation } from '../agent/automation-projection.ts';
import type { NativeAutomation } from '../agent/automation-gateway.ts';
import { intakeLocation } from '../channels/github/intake/record-store.ts';
import type { AgentManifest } from '../manifest/types.ts';
import createIntakeTool from '../tools/intake/tool.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

function manifest() {
  const { policy } = intakeFixture();
  return {
    automations: undefined as AgentManifest['automations'],
    schemaVersion: 1,
    agent: { id: 'receiver' },
    models: {
      default: { model: 'openai/gpt-6-luna', effort: 'medium' },
      low: { model: 'openai/gpt-6-luna', effort: 'medium' },
    },
    github: { username: 'receiver', notifications: { ...policy, runtimes: ['codex', 'openclaw'] } },
  } satisfies AgentManifest;
}

describe('openclaw v2 intake slice', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/openclaw-intake-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  function fixture() {
    const value = manifest();
    const provider = intakeFixture();
    provider.events.length = 0;
    let now = baseline;
    let connects = 0;
    const loaded = {
      status: 'loaded' as const,
      manifest: value,
      scope: { workspaceDir: root, agentId: value.agent.id },
      path: join(root, 'agent.yaml'),
      diagnostics: [],
      validationChecks: [],
      digest: 'fixture',
    };
    const manifests = {
      async loadForAgentId() {
        return loaded;
      },
      async loadForCommandDirectory() {
        throw Error('must bind native agent');
      },
    };
    const service = new OpenClawIntake({
      root: join(root, 'v2'),
      namespace: root,
      manifestService: manifests,
      now: () => now,
      async connect() {
        connects++;
        return provider.client;
      },
    });
    return {
      value,
      provider,
      service,
      loaded,
      manifests,
      connects: () => connects,
      setNow: (v: number) => {
        now = v;
      },
    };
  }
  it('should restrict both native check and scan to each isolated fixtures selected issue', async () => {
    const f = fixture();
    const digest = assignmentIntakePolicy(f.value, 'openclaw')!.digest;
    const second = new OpenClawIntake({ ...f.service.dependencies, root: join(root, 'second') });
    await f.service.run(f.value, root, 'activate');
    await second.run(f.value, root, 'activate');
    f.provider.events.push(...intakeFixture().events);
    f.setNow(baseline + 120000);
    f.provider.client.discoverAssigned = async () => {
      throw Error('must not scan the shared inbox');
    };
    f.provider.client.getItem = async (_owner, _repo, number) => ({
      ...f.provider.item,
      number,
      nodeId: `I_${number}`,
      databaseId: number,
    });
    for (const [service, number] of [
      [f.service, 3],
      [second, 4],
    ] as const) {
      const selector = { itemType: 'issue' as const, repository: 'owner/repo', number };
      const check = await service.run(f.value, root, 'check', digest, undefined, selector);
      assert.equal(check.changed, true);
      assert.deepEqual((await service.inspect(f.value, root)).records, []);
      await service.run(f.value, root, 'scan', digest, undefined, selector);
      assert.deepEqual(
        (await service.inspect(f.value, root)).records.map((record) => record.issue.number),
        [number],
      );
      assert.equal((await service.inspect(f.value, root)).checkpoint, baseline);
    }
    f.provider.client.discoverAssigned = async () => ({
      candidates: [3, 4].map((number) => ({
        itemType: 'issue',
        repositoryPath: '/repos/owner/repo',
        number,
        nodeId: `I_${number}`,
        databaseId: number,
        updatedAt: f.provider.item.updatedAt,
      })),
      incomplete: false,
      truncated: false,
      totalCount: 2,
    });
    await f.service.run(f.value, root, 'scan', digest);
    assert.deepEqual(
      (await f.service.inspect(f.value, root)).records.map((record) => record.issue.number),
      [3, 4],
    );
    assert.equal((await f.service.inspect(f.value, root)).checkpoint, baseline + 120000);
  });

  it('should report supported planning through native doctor and install without starting issue sessions', async () => {
    const f = fixture();
    const unused = async (): Promise<never> => {
      throw Error('unexpected diagnostic');
    };
    const contribution = f.service.contribution();
    const registry = new AgentSystemLifecycleRegistry([contribution]);
    const doctor = new AgentDoctorService({ lifecycleRegistry: registry });
    const context = { manifest: f.value, workspaceDir: root, runtime: 'openclaw' as const };
    assert.deepEqual(contribution.validate!(context)?.diagnostics, []);
    async function inspect(expected: 'healthy' | 'drift', code: string) {
      const output: string[] = [];
      const exits: number[] = [];
      await doctorAgentSystem({
        doctorService: doctor,
        manifestService: {
          loadForAgentId: async () => f.loaded,
          loadForCommandDirectory: async () => f.loaded,
        },
        workspaceDir: root,
        json: true,
        output: { writeStdout: (value) => output.push(value), writeStderr: unused },
        setExitCode: (value) => exits.push(value),
      });
      const result = JSON.parse(output.join(''));
      assert.equal(result.status, expected);
      assert.deepEqual(
        result.findings.map((finding: { code: string }) => finding.code),
        [code],
      );
      assert.deepEqual(exits, expected === 'healthy' ? [] : [1]);
    }
    await inspect('drift', 'intake-activation-required');
    assert.equal(f.connects(), 0);
    const installed = await registry.reconcile(context);
    assert.deepEqual(installed.warnings, []);
    assert.ok(installed.outcomes.some((item) => item.code === 'intake-activated'));
    await inspect('healthy', 'intake-ready');
    const notifications = f.value.github.notifications;
    notifications.intervalMinutes++;
    await inspect('drift', 'intake-policy-reconciliation-required');
  });

  it('should block unsupported native workflows before provider access or activation', async () => {
    const f = fixture();
    f.value.github.notifications.issueAssignment!.mode = 'work';
    const contribution = f.service.contribution();
    const context = { manifest: f.value, workspaceDir: root, runtime: 'openclaw' as const };
    assert.equal(
      contribution.validate!(context)?.diagnostics?.[0]?.code,
      'github-notification-runtime-unsupported',
    );
    assert.equal(
      (await f.service.inspect(f.value, root)).code,
      'github-notification-runtime-unsupported',
    );
    const result = await contribution.reconcile!(context);
    assert.equal(result.outcomes[0]?.status, 'skipped');
    assert.equal(result.warnings?.[0]?.code, 'github-notification-runtime-unsupported');
    await assert.rejects(f.service.run(f.value, root, 'activate'), {
      code: 'github-notification-runtime-unsupported',
    });
    assert.equal(f.connects(), 0);
  });

  it('should carry notification presentation context through the registry without changing serialized records', async () => {
    const f = fixture();
    f.value.github.notifications.issueAssignment!.mode = 'work';
    f.value.github.notifications.issueAssignment!.assessment = { skill: 'replacement-skill' };
    f.value.github.notifications.issueAssignment!.feedback = { inherit: true, allowed: [] };
    f.value.github.notifications.reviewRequest = {
      enabled: true,
      allowed: [{ login: 'operator', nodeId: 'U_operator' }],
    };
    const registry = new AgentSystemLifecycleRegistry([f.service.contribution()]);
    const context = { manifest: f.value, workspaceDir: root, runtime: 'openclaw' as const };
    const validated = registry.validate(context);
    const reconciled = await registry.reconcile(context);
    assert.equal(validated.diagnostics.length, 3);
    assert.equal(reconciled.warnings.length, 3);
    assert.deepEqual(
      reconciled.warnings.map(getCliDiagnosticContext),
      validated.diagnostics.map(getCliDiagnosticContext),
    );
    assert.ok(
      reconciled.warnings.every((warning) => getCliDiagnosticContext(warning)?.remediation?.length),
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(reconciled.warnings)),
      reconciled.warnings.map(({ code, component, message }) => ({ code, component, message })),
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(validated.diagnostics)),
      validated.diagnostics.map(({ code, component, message, fieldPath, severity }) => ({
        code,
        component,
        message,
        fieldPath,
        severity,
      })),
    );
    const installed = { agentId: f.value.agent.id, workspaceDir: root, ...reconciled };
    for (const json of [false, true]) {
      const events: { stream: string; text: string }[] = [];
      await installAgentSystem({
        installService: { install: async () => installed },
        manifestService: {
          loadForCommandDirectory: async () => ({
            ...f.loaded,
            diagnostics: validated.diagnostics,
          }),
        },
        json,
        workspaceDir: root,
        styles: createCliStyles({ NO_COLOR: '1' }),
        terminalColumns: 240,
        output: {
          writeStdout: (text) => events.push({ stream: 'stdout', text }),
          writeStderr: (text) => events.push({ stream: 'stderr', text }),
        },
        setExitCode: () => assert.fail('warnings must not fail install'),
      });
      const stderr = events
        .filter(({ stream }) => stream === 'stderr')
        .map(({ text }) => text)
        .join('');
      assert.equal(events.at(-1)?.stream, 'stderr');
      assert.equal(stderr.match(/code=github-notification-runtime-unsupported/gu)?.length, 3);
      for (const diagnostic of validated.diagnostics) {
        assert.equal(stderr.split(`field=${diagnostic.fieldPath}`).length - 1, 1);
        assert.equal(
          stderr.split(getCliDiagnosticContext(diagnostic)!.remediation![0]!).length - 1,
          1,
        );
      }
      if (json) assert.equal(events[0]!.text, `${JSON.stringify(installed, undefined, 2)}\n`);
      else assert.equal(stderr.match(/⚠ warning/gu)?.length, 3);
    }
    assert.equal(f.connects(), 0);
  });

  it('should activate and scan assignments while warning about independent unavailable capabilities', async () => {
    const f = fixture();
    f.value.github.notifications.issueAssignment!.feedback = { inherit: true, allowed: [] };
    f.value.github.notifications.reviewRequest = {
      enabled: true,
      allowed: [{ login: 'operator', nodeId: 'U_operator' }],
    };
    const contribution = f.service.contribution();
    const context = { manifest: f.value, workspaceDir: root, runtime: 'openclaw' as const };
    const diagnostics = contribution.validate!(context)?.diagnostics;
    assert.deepEqual(
      diagnostics?.map(({ code, fieldPath, severity }) => ({ code, fieldPath, severity })),
      [
        {
          code: 'github-notification-runtime-unsupported',
          fieldPath: '/github/notifications/review-request',
          severity: 'warning',
        },
      ],
    );
    assert.equal((await f.service.inspect(f.value, root)).code, 'intake-activation-required');
    assert.equal(f.connects(), 0);
    const result = await contribution.reconcile!(context);
    assert.equal(result.outcomes[0]?.code, 'intake-activated');
    assert.deepEqual(
      result.warnings?.map(({ code }) => code),
      ['github-notification-runtime-unsupported'],
    );
    assert.match(result.warnings![0]!.message, /review requests/i);
    const findings = await contribution.inspect!(context);
    assert.ok(findings.some(({ code, status }) => code === 'intake-ready' && status === 'healthy'));
    const warnings = findings.filter(({ status }) => status === 'warning');
    assert.deepEqual(
      warnings.map(({ code }) => code),
      ['github-notification-runtime-unsupported'],
    );
    assert.match(warnings[0]!.message, /review requests/i);
    assert.ok(!findings.some(({ status }) => status === 'blocked'));
    f.provider.events.push(...intakeFixture().events);
    f.setNow(baseline + 120000);
    const digest = assignmentIntakePolicy(f.value, 'openclaw')!.digest;
    assert.equal((await f.service.run(f.value, root, 'check', digest)).changed, true);
    assert.equal((await f.service.run(f.value, root, 'scan', digest)).admitted, 1);
    assert.equal((await f.service.inspect(f.value, root)).records.length, 1);
    assert.equal(openclawIntakeJobs(f.value).length, 1);
    assert.equal((await contribution.reconcile!(context)).outcomes[0]?.code, 'intake-retained');
  });

  it('should share the Codex policy contract and isolate runtime identity and V1 files', async () => {
    const f = fixture();
    assert.equal(
      assignmentIntakePolicy(f.value, 'openclaw')!.digest,
      codexIntakePolicy(f.value)!.digest,
    );
    const { store } = await f.service.select(f.value, root);
    const codex = intakeLocation({
      root: join(root, 'v2'),
      namespace: root,
      runtime: 'codex',
      workspaceDir: root,
      agentId: 'receiver',
    });
    assert.notEqual(store.location.scope, codex.scope);
    await writeFile(join(root, 'v1-state.json'), 'untouched');
    await f.service.run(f.value, root, 'activate');
    assert.equal(await readFile(join(root, 'v1-state.json'), 'utf8'), 'untouched');
    assert.equal((await store.read())!.records.length, 0);
  });
  it('should keep checks read-only, commit a real assignment once and retain only admission evidence', async () => {
    const f = fixture();
    const digest = assignmentIntakePolicy(f.value, 'openclaw')!.digest;
    const { store } = await f.service.select(f.value, root);
    assert.equal((await f.service.inspect(f.value, root)).code, 'intake-activation-required');
    assert.equal(f.connects(), 0);
    await assert.rejects(f.service.run(f.value, root, 'check', digest), {
      code: 'intake-activation-required',
    });
    assert.equal(await store.read(), undefined);
    await f.service.run(f.value, root, 'activate');
    f.provider.events.push(...intakeFixture().events);
    f.setNow(baseline + 120000);
    const before = JSON.stringify(await store.read());
    assert.equal((await f.service.run(f.value, root, 'check', digest)).changed, true);
    assert.equal(JSON.stringify(await store.read()), before);
    assert.equal((await f.service.run(f.value, root, 'scan', digest)).admitted, 1);
    assert.equal((await f.service.run(f.value, root, 'scan', digest)).admitted, 0);
    assert.equal((await f.service.run(f.value, root, 'check', digest)).changed, false);
    const state = (await store.read())!;
    assert.equal(state.baselineAt, baseline);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0]!.status, 'admitted');
    assert.equal(state.records[0]!.requiresRevalidation, true);
    for (const key of ['session', 'sessionKey', 'assessment', 'workflow', 'issueStatus'])
      assert.equal(key in state.records[0]!, false);
    const context = { manifest: f.value, workspaceDir: root } as never;
    assert.equal(
      (await f.service.contribution().reconcile!(context)).outcomes[0]!.status,
      'unchanged',
    );
    assert.equal((await store.read())!.baselineAt, baseline);
    f.value.github!.notifications!.intervalMinutes = 10;
    await assert.rejects(f.service.run(f.value, root, 'scan', digest), {
      code: 'intake-policy-changed',
    });
    await f.service.contribution().reconcile!(context);
    assert.equal((await store.read())!.baselineAt, baseline);
    assert.equal((await store.read())!.records.length, 1);
  });
  it('should fail closed before credentials on disabled or stale policy and changed workspace authority', async () => {
    const f = fixture();
    const digest = assignmentIntakePolicy(f.value, 'openclaw')!.digest;
    await assert.rejects(f.service.run(f.value, root, 'scan', digest, AbortSignal.abort()), {
      name: 'AbortError',
    });
    await assert.rejects(f.service.run(f.value, root, 'scan', '0'.repeat(64)), {
      code: 'intake-policy-changed',
    });
    f.loaded.scope.workspaceDir = '/tmp';
    await assert.rejects(f.service.run(f.value, root, 'scan', digest), {
      code: 'intake-policy-changed',
    });
    f.value.github!.notifications!.runtimes = ['codex'];
    await assert.rejects(f.service.run(f.value, root, 'scan', digest), {
      code: 'intake-policy-disabled',
    });
    assert.equal(f.connects(), 0);
  });
  it('should expose failed and recovered previews without writing a checkpoint', async () => {
    const f = fixture();
    await f.service.run(f.value, root, 'activate');
    const digest = assignmentIntakePolicy(f.value, 'openclaw')!.digest;
    const discover = f.provider.client.discoverAssigned;
    f.provider.client.discoverAssigned = async () => {
      throw Error('provider secret');
    };
    const { store } = await f.service.select(f.value, root);
    const before = JSON.stringify(await store.read());
    const preview = await f.service.run(f.value, root, 'check', digest);
    assert.equal(preview.changed, true);
    assert.equal(preview.code, 'intake-provider-unavailable');
    assert.equal(JSON.stringify(preview).includes('secret'), false);
    assert.equal(JSON.stringify(await store.read()), before);
    await f.service.run(f.value, root, 'scan', digest);
    assert.equal((await f.service.run(f.value, root, 'check', digest)).changed, false);
    f.setNow(baseline + 300001);
    f.provider.client.discoverAssigned = discover;
    assert.equal((await f.service.run(f.value, root, 'check', digest)).recovered, true);
    assert.ok((await store.read())!.blocker);
    await f.service.run(f.value, root, 'scan', digest);
    assert.equal((await store.read())!.blocker, undefined);
  });
  it('should reject the wrong receiving identity without admitting anything', async () => {
    const f = fixture();
    f.provider.client = {
      ...f.provider.client,
      identity: { login: 'other', nodeId: 'U_other', type: 'User' },
    };
    await assert.rejects(f.service.run(f.value, root, 'activate'), {
      code: 'intake-github-identity-mismatch',
    });
    const { store } = await f.service.select(f.value, root);
    assert.equal(await store.read(), undefined);
  });
  it('should derive only the enabled OpenClaw job and preserve its desired trigger on every reconciliation', () => {
    const value = manifest();
    value.models.default = { model: 'openai/gpt-6-astra', effort: 'medium' };
    const [job] = openclawIntakeJobs(value);
    assert.ok(job);
    assert.equal(value.automations, undefined);
    assert.equal(job.schedule.kind, 'every');
    assert.equal(job.internalOpenClaw!.group, 'Agent System');
    assert.equal(job.overrides.openclaw!.model, 'openai/gpt-6-astra');
    assert.equal(job.overrides.openclaw!.effort, 'medium');
    assert.equal(value.models.low.model, 'openai/gpt-6-luna');
    const desired = projectAutomation(job, { anchorMs: baseline, marker: 'owned' } as never, {
      agentId: 'receiver',
      workspaceDir: root,
      command: [],
      environment: {},
      timezone: 'UTC',
    });
    const current = {
      ...desired,
      id: 'native',
      configRevision: '1',
      state: {},
    } as NativeAutomation;
    assert.equal(desired.name, 'Agent System: github-issue-assignment');
    assert.deepEqual(desired.payload.toolsAllow, ['*']);
    const restricted = {
      ...current,
      payload: { ...current.payload, toolsAllow: ['agent_system_intake'] },
    } as NativeAutomation;
    const restored = automationPatch(restricted, desired);
    assert.deepEqual((restored.payload as Record<string, unknown>).toolsAllow, ['*']);
    assert.deepEqual(automationPatch(current, desired), {});
    const changed = { ...desired, trigger: { script: 'changed' } };
    assert.deepEqual(automationPatch(current, changed), { trigger: { script: 'changed' } });
    const removed = { ...desired };
    delete removed.trigger;
    assert.deepEqual(automationPatch(current, removed), { trigger: null });
    value.github!.notifications!.runtimes = ['codex'];
    assert.equal(openclawIntakeJobs(value).length, 0);
    value.github!.notifications!.runtimes = ['openclaw'];
    value.github!.notifications!.issueAssignment!.enabled = false;
    assert.equal(openclawIntakeJobs(value).length, 0);
    value.automations = [job];
    assert.throws(() => openclawIntakeJobs(value), { code: 'intake-automation-id-reserved' });
  });
  it('should keep the trigger quiet for empty scans and wake on changes or failed conditions', async () => {
    const script = openclawIntakeJobs(manifest())[0]!.internalOpenClaw!.trigger.script;
    for (const changed of [false, true]) {
      let output: { fire: boolean } | undefined;
      await runInNewContext(`(async()=>{${script}})()`, {
        agent_system_dispatch: async () => ({ status: 'ready', changed: false }),
        agent_system_intake: async (args: unknown) => {
          assert.equal((args as { action: string }).action, 'check');
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'ready', changed }) }],
          };
        },
        json: (value: { fire: boolean }) => {
          output = value;
        },
      });
      assert.equal(output!.fire, changed);
    }
    let invalid: { fire: boolean } | undefined;
    await runInNewContext(`(async()=>{${script}})()`, {
      agent_system_intake: async () => ({}),
      json: (value: { fire: boolean }) => {
        invalid = value;
      },
    });
    assert.equal(invalid!.fire, true);
    let output: unknown;
    await runInNewContext(`(async()=>{${script}})()`, {
      agent_system_intake: async () => {
        throw Error('secret transport diagnostic');
      },
      json: (value: unknown) => {
        output = value;
      },
    });
    assert.equal((output as { fire: boolean }).fire, true);
    assert.equal(JSON.stringify(output).includes('secret'), false);
  });
  it('should pass native structured results to the scheduled quiet condition', async () => {
    const f = fixture();
    await f.service.run(f.value, root, 'activate');
    let factory: Parameters<OpenClawPluginApi['registerTool']>[0] | undefined;
    createIntakeTool(f.service, f.manifests).registerTools(
      {
        registerTool(value) {
          factory = value;
        },
      },
      {} as never,
    );
    if (typeof factory !== 'function') throw Error('missing factory');
    const tool = await factory({ agentId: 'receiver', workspaceDir: root });
    assert.ok(tool && !Array.isArray(tool));
    const script = openclawIntakeJobs(f.value)[0]!.internalOpenClaw!.trigger.script;
    const { store } = await f.service.select(f.value, root);
    for (const changed of [false, true]) {
      if (changed) {
        f.provider.events.push(...intakeFixture().events);
        f.setNow(baseline + 120000);
      }
      const before = JSON.stringify(await store.read());
      let output: { fire: boolean; state: { status: string } } | undefined;
      await runInNewContext(`(async()=>{${script}})()`, {
        agent_system_dispatch: async () => ({ status: 'ready', changed: false }),
        agent_system_intake: async (args: unknown) => {
          const result = await tool.execute('condition', args);
          assert.deepEqual(
            result.details,
            JSON.parse((result.content[0] as { text: string }).text),
          );
          return result.details;
        },
        json: (value: typeof output) => {
          output = value;
        },
      });
      assert.equal(output!.fire, changed);
      assert.equal(output!.state.status, 'ready');
      assert.equal(JSON.stringify(await store.read()), before);
    }
  });
  it('should retain the failed check stage and safe diagnostic without exposing raw errors', async () => {
    const script = openclawIntakeJobs(manifest())[0]!.internalOpenClaw!.trigger.script;
    const cases = [
      {
        stage: 'intake',
        error: new Error('private transport detail'),
        code: 'intake-condition-failed',
      },
      {
        stage: 'dispatch',
        error: new Error('dispatch-native-caller-unavailable'),
        code: 'dispatch-native-caller-unavailable',
      },
      {
        stage: 'dispatch',
        error: new Error('private transport detail'),
        code: 'dispatch-condition-failed',
      },
      {
        stage: 'dispatch',
        error: { code: 'private-credential-value' },
        code: 'dispatch-condition-failed',
      },
    ];
    for (const sample of cases) {
      let output:
        | { fire: boolean; message: string; state: { status: string; stage: string; code: string } }
        | undefined;
      await runInNewContext(`(async()=>{${script}})()`, {
        agent_system_intake: async () => {
          if (sample.stage === 'intake') throw sample.error;
          return { status: 'ready', changed: false };
        },
        agent_system_dispatch: async () => {
          throw sample.error;
        },
        json: (value: typeof output) => {
          output = value;
        },
      });
      assert.equal(output!.fire, true);
      assert.equal(output!.state.status, 'blocked');
      assert.equal(output!.state.stage, sample.stage);
      assert.equal(output!.state.code, sample.code);
      assert.ok(output!.message.includes(sample.code));
      assert.equal(JSON.stringify(output).includes('private'), false);
    }
  });
  it('should inspect and wait through public commands using the native durable baseline', async () => {
    const f = fixture();
    await f.service.run(f.value, root, 'activate');
    const connections = f.connects();
    const nativeService = new OpenClawNotifications({
      root: join(root, 'dispatch'),
      intake: f.service,
      async scanSelected() {
        throw Error('read-only commands must not scan');
      },
      async inspectRun() {
        return 'pending' as const;
      },
      async requestRun(): Promise<never> {
        throw Error('read-only commands must not queue');
      },
    });
    const stdout: string[] = [];
    const options = {
      nativeService,
      json: true,
      workspaceDir: root,
      manifestService: { ...f.manifests, loadForCommandDirectory: async () => f.loaded },

      output: {
        writeStdout: (text: string) => stdout.push(text),
        writeStderr: (text: string) => {
          throw Error(text);
        },
      },
      setExitCode: (code: number) => assert.equal(code, 0),
    };
    await notificationStatus(options);
    assert.equal(JSON.parse(stdout.pop()!).baseline.status, 'ready');
    await notificationWait({ ...options, target: 'baseline-ready', refresh: false });
    assert.equal(JSON.parse(stdout.pop()!).status, 'completed');
    assert.equal(f.connects(), connections);
    assert.deepEqual((await f.service.inspect(f.value, root)).records, []);
  });
  it('should bind the tool to the native agent and reject caller-selected identities or activation', async () => {
    const f = fixture();
    let factory: Parameters<OpenClawPluginApi['registerTool']>[0] | undefined;
    createIntakeTool(f.service, f.manifests).registerTools(
      {
        registerTool(value) {
          factory = value;
        },
      },
      {} as never,
    );
    assert.equal(typeof factory, 'function');
    if (typeof factory !== 'function') throw Error('missing factory');
    const tool = await factory({ agentId: 'receiver', workspaceDir: root });
    assert.ok(tool && !Array.isArray(tool));
    for (const request of [
      { action: 'activate' },
      { action: 'inspect', agentId: 'other' },
      { action: 'scan', policyDigest: 'invalid' },
    ]) {
      await assert.rejects(tool.execute('call', request), { code: 'intake-request-invalid' });
    }
    await tool.execute('call', { action: 'inspect' });
    const wrong = await factory({ agentId: 'receiver', workspaceDir: '/tmp' });
    assert.ok(wrong && !Array.isArray(wrong));
    await assert.rejects(wrong.execute('call', { action: 'inspect' }), /bind the active/);
    assert.equal(f.connects(), 0);
  });
});
