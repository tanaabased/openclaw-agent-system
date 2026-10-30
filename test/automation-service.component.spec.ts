import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { prepareAutomationReport } from '../agent/automation-report.ts';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AutomationError,
  createAutomationGateway,
  type AutomationGateway,
  type NativeAutomation,
} from '../agent/automation-gateway.ts';
import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
import {
  automationPatch,
  nativeAutomationHash,
  effectiveAutomation,
} from '../agent/automation-projection.ts';
import AutomationService from '../agent/automation-service.ts';
import notificationAutomationReadiness from '../agent/automation-readiness.ts';
import AgentInstallService from '../agent/install-service.ts';
import AgentSystemLifecycleRegistry, {
  AgentSystemLifecycleError,
} from '../core/lifecycle-registry.ts';
import { intakeFixture } from './github-intake-fixture.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';

function jobs(input: unknown): ResolvedAutomation[] {
  const result = normalizeAutomations(input);
  assert.equal(result.status, 'valid');
  if (result.status !== 'valid') throw new Error('invalid fixture');
  return result.automations as ResolvedAutomation[];
}

describe('agent/automation-service', () => {
  let root: string;
  let manifest: AgentManifest;
  let service: AutomationService;
  let native: NativeAutomation[];
  let calls: { method: string; params: Record<string, unknown> }[];
  let now: number;
  let revision: number;
  let fail: string | undefined;
  let afterWriteFailure: boolean;
  let loaded: boolean;
  let manifestDigest: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/automation-'));
    manifest = {
      schemaVersion: 1,
      agent: { id: 'tanaabot' },
      automations: jobs([{ id: 'check', schedule: 'in 1 hour', run: ['gh', 'api', 'user'] }]),
    };
    native = [];
    calls = [];
    now = 1_900_000_000_000;
    revision = 0;
    loaded = true;
    manifestDigest = 'fixture';
    fail = undefined;
    afterWriteFailure = false;
    const request: AutomationGateway = async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      if (
        fail === method ||
        (fail === 'second-add' && method === 'cron.add' && native.length === 1)
      )
        throw new Error('secret provider text must not escape');
      if (method === 'sessions.resolve') return { ok: false };
      if (method === 'cron.status') return { enabled: true, jobs: native.length };
      if (method === 'cron.list') return { jobs: structuredClone(native), hasMore: false };
      if (method === 'cron.get') {
        const job = native.find(({ id }) => id === params.id);
        if (!job) throw new Error('missing');
        return structuredClone(job);
      }
      if (method === 'cron.run') return { ok: true, enqueued: true, runId: 'run-1' };
      if (method === 'cron.runs')
        return {
          entries: [
            {
              ts: now,
              jobId: params.id,
              runId: 'run-1',
              action: 'finished',
              status: 'ok',
              deliveryStatus: 'not-delivered',
              deliveryError: 'secret',
            },
          ],
          total: 1,
          offset: 0,
          limit: params.limit,
          hasMore: false,
          nextOffset: null,
        };
      if (method === 'cron.add') {
        const job = {
          ...structuredClone(params),
          id: `native-${native.length}`,
          configRevision: String(++revision),
          state: {},
        } as NativeAutomation;
        if (job.payload.kind === 'agentTurn' && job.payload.toolsAllow === undefined)
          job.payload.toolsAllow = ['*'];
        native.push(job);
        if (afterWriteFailure) {
          afterWriteFailure = false;
          throw new Error('lost acknowledgement');
        }
        return { job: structuredClone(job), action: 'created' };
      }
      const job = native.find(({ id }) => id === params.id)!;
      assert.equal(params.expectedConfigRevision, job.configRevision);
      const patch = structuredClone(params.patch) as Record<string, unknown>;
      // native at/recurring transitions reset retention when it is omitted.
      const schedule = patch.schedule as Record<string, unknown> | undefined;
      if (patch.deleteAfterRun === undefined && schedule?.kind !== job.schedule.kind) {
        if (schedule?.kind === 'at') job.deleteAfterRun = true;
        else if (job.schedule.kind === 'at' && ['every', 'cron'].includes(String(schedule?.kind)))
          delete job.deleteAfterRun;
      }
      if (patch.payload) {
        const payload = patch.payload as Record<string, unknown>;
        patch.payload =
          payload.kind === job.payload.kind ? { ...job.payload, ...payload } : payload;
        for (const [key, value] of Object.entries(patch.payload as object))
          if (value === null) delete (patch.payload as Record<string, unknown>)[key];
      }
      if (patch.delivery) {
        patch.delivery = { ...(job.delivery as object), ...(patch.delivery as object) };
        for (const [key, value] of Object.entries(patch.delivery as object))
          if (value === null) delete (patch.delivery as Record<string, unknown>)[key];
      }
      Object.assign(job, patch, { configRevision: String(++revision) });
      if (job.payload.kind === 'agentTurn' && job.payload.toolsAllow === undefined)
        job.payload.toolsAllow = ['*'];
      for (const key of ['displayName', 'trigger', 'pacing', 'sessionKey'])
        if (job[key] === null) delete job[key];
      if (afterWriteFailure) {
        afterWriteFailure = false;
        throw new Error('lost acknowledgement');
      }
      return structuredClone(job);
    };
    service = new AutomationService({
      root: join(root, 'state'),
      profile: root,
      command: ['/usr/bin/node', '/fixed/openclaw.mjs'],
      environment: { OPENCLAW_STATE_DIR: root },
      now: () => now,
      timezone: 'UTC',
      request: createAutomationGateway(async (method, _options, params) =>
        request(method as Parameters<AutomationGateway>[0], params as Record<string, unknown>),
      ),
      manifestService: {
        async loadForAgentId() {
          return loaded
            ? {
                status: 'loaded',
                manifest,
                scope: { workspaceDir: root, agentId: 'tanaabot' },
                path: join(root, 'agent.yaml'),
                diagnostics: [],
                validationChecks: [],
                digest: manifestDigest,
              }
            : { status: 'unresolved', diagnostics: [] };
        },
      },
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const mutations = () =>
    calls.filter(({ method }) => ['cron.add', 'cron.update'].includes(method));

  for (const payload of [{ run: ['node', 'task.js'] }, { prompt: 'Review.' }])
    it(`should migrate declared ${'run' in payload ? 'command' : 'prompt'} names without changing job state`, async () => {
      manifest.agent.name = 'Different display identity';
      manifest.automations = jobs([
        { id: 'github-declared-job', schedule: 'every 1 hour', enabled: false, ...payload },
      ]);
      await service.reconcile(manifest, root);
      const { store } = await service.scope(manifest, root);
      const ledger = await store.read();
      const record = structuredClone(ledger.records[0]!);
      native[0]!.name = 'Agent System: github-declared-job';
      native[0]!.state = { lastRunAtMs: now, lastRunStatus: 'ok', nextRunAtMs: now + 3600000 };
      ledger.records[0]!.nativeHash = nativeAutomationHash(native[0]!);
      await store.write(ledger);
      const before = structuredClone(native[0]!);
      calls = [];
      await service.reconcile(manifest, root);
      assert.deepEqual(
        mutations().map(({ method, params }) => ({ method, patch: params.patch })),
        [{ method: 'cron.update', patch: { name: 'TANAABOT: github-declared-job' } }],
      );
      assert.deepEqual(native[0], {
        ...before,
        name: 'TANAABOT: github-declared-job',
        configRevision: native[0]!.configRevision,
      });
      const after = (await store.read()).records[0]!;
      assert.deepEqual(after, { ...record, nativeHash: nativeAutomationHash(native[0]!) });
      calls = [];
      await service.reconcile(manifest, root);
      assert.deepEqual(mutations(), []);
    });

  for (const state of ['recurring', 'disabled', 'completed'] as const)
    it(`should migrate legacy capture for ${state} jobs without replacing or rescheduling them`, async () => {
      if (state !== 'completed')
        manifest.automations = jobs([
          {
            id: 'check',
            schedule: 'every 1 hour',
            enabled: state !== 'disabled',
            run: ['gh', 'api', 'user'],
          },
        ]);
      await service.reconcile(manifest, root);
      assert.equal(native[0]!.payload.outputMaxBytes, undefined);
      native[0]!.payload.outputMaxBytes = 16384;
      native[0]!.state = {
        lastRunAtMs: now,
        lastRunStatus: 'ok',
        ...(state === 'completed' ? {} : { nextRunAtMs: now + 3600000 }),
      };
      if (state === 'completed') native[0]!.enabled = false;
      const { store } = await service.scope(manifest, root);
      const ledger = await store.read();
      ledger.records[0]!.nativeHash = nativeAutomationHash(native[0]!);
      await store.write(ledger);
      const before = structuredClone(native[0]!);
      const record = structuredClone(ledger.records[0]!);
      if (state === 'recurring') {
        await service.admit(manifest, root, 'check', record.hash);
        await service.run(manifest, root, 'check');
      }
      assert.ok(
        (await service.inspect(manifest, root)).some(({ code }) => code === 'automation-drift'),
      );
      calls = [];
      await service.reconcile(manifest, root);
      assert.equal(native.length, 1);
      assert.deepEqual(native[0], {
        ...before,
        configRevision: native[0]!.configRevision,
        payload: { ...before.payload, outputMaxBytes: 16777216 },
      });
      assert.deepEqual(
        mutations().map(({ params }) => params.patch),
        [{ payload: { ...before.payload, outputMaxBytes: 16777216, toolsAllow: null } }],
      );
      const after = (await store.read()).records[0]!;
      assert.deepEqual(after, {
        ...record,
        nativeHash: nativeAutomationHash(native[0]!),
        ...(state === 'completed' ? { completion: 'ok' } : {}),
      });
      if (state === 'recurring') {
        await service.admit(manifest, root, 'check', after.hash);
        await service.run(manifest, root, 'check');
        native[0]!.payload.outputMaxBytes = 42;
        await assert.rejects(service.run(manifest, root, 'check'), /execution-drift/);
        await assert.rejects(service.admit(manifest, root, 'check', after.hash), /execution-drift/);
        native[0]!.payload.outputMaxBytes = 16777216;
      }
      calls = [];
      await service.reconcile(manifest, root);
      assert.deepEqual(mutations(), []);
      assert.equal(
        (await service.inspect(manifest, root)).some(({ code }) => code === 'automation-drift'),
        false,
      );
    });

  it('should admit scheduled commands on both sides of an output-only native update', async () => {
    await service.reconcile(manifest, root);
    native[0]!.payload.outputMaxBytes = 16384;
    const { store } = await service.scope(manifest, root);
    const ledger = await store.read();
    const record = ledger.records[0]!;
    record.nativeHash = nativeAutomationHash(native[0]!);
    await store.write(ledger);
    const original = service.dependencies.request!;
    let admissions = 0;
    service.dependencies.request = async (method, params) => {
      if (method !== 'cron.update') return original(method, params);
      await service.admit(manifest, root, 'check', record.hash);
      admissions++;
      const response = await original(method, params);
      await service.admit(manifest, root, 'check', record.hash);
      admissions++;
      return response;
    };
    await service.reconcile(manifest, root);
    assert.equal(admissions, 2);
    assert.equal(native[0]!.payload.outputMaxBytes, 16777216);
  });

  it('should keep the old capture configuration runnable after a rejected update without allowing drift', async () => {
    await service.reconcile(manifest, root);
    native[0]!.payload.outputMaxBytes = 16384;
    const { store } = await service.scope(manifest, root);
    const ledger = await store.read();
    ledger.records[0]!.nativeHash = nativeAutomationHash(native[0]!);
    await store.write(ledger);
    fail = 'cron.update';
    await assert.rejects(service.reconcile(manifest, root));
    const hash = ledger.records[0]!.hash;
    await service.admit(manifest, root, 'check', hash);
    const before = structuredClone(native[0]!);
    for (const change of [
      { payload: { ...before.payload, outputMaxBytes: 42 } },
      { payload: { ...before.payload, argv: ['another-command'] } },
      { schedule: { kind: 'every', everyMs: 1000 } },
      { enabled: false },
      { state: { autoDisabled: true } },
    ]) {
      native[0] = { ...before, ...change };
      await assert.rejects(service.admit(manifest, root, 'check', hash), /execution-drift/);
    }
    native[0] = before;
    await service.admit(manifest, root, 'check', hash);
    native[0]!.enabled = false;
    native[0]!.state = { lastRunAtMs: now, lastRunStatus: 'ok' };
    fail = undefined;
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.enabled, false);
    assert.deepEqual(native[0]!.state, { lastRunAtMs: now, lastRunStatus: 'ok' });
    assert.equal(native[0]!.payload.outputMaxBytes, 16777216);
    assert.equal((await store.read()).records[0]!.pending, undefined);
  });

  for (const changed of ['command', 'schedule'] as const)
    it(`should keep pending ${changed} changes blocked even when they also migrate capture`, async () => {
      await service.reconcile(manifest, root);
      native[0]!.payload.outputMaxBytes = 16384;
      const { store, context } = await service.scope(manifest, root);
      const ledger = await store.read();
      ledger.records[0]!.nativeHash = nativeAutomationHash(native[0]!);
      await store.write(ledger);
      manifest.automations = jobs([
        {
          id: 'check',
          schedule: changed === 'schedule' ? 'in 2 hours' : 'in 1 hour',
          run: changed === 'command' ? ['gh', 'api', 'repos'] : ['gh', 'api', 'user'],
        },
      ]);
      afterWriteFailure = true;
      await assert.rejects(service.reconcile(manifest, root));
      const hash = effectiveAutomation(manifest.automations[0]!, context).hash;
      await assert.rejects(service.admit(manifest, root, 'check', hash), /execution-stale/);
    });

  it('should reject a substantive pending update recorded during native admission readback', async () => {
    await service.reconcile(manifest, root);
    const { store } = await service.scope(manifest, root);
    const ledger = await store.read();
    const original = service.dependencies.request!;
    service.dependencies.request = async (method, params) => {
      const response = await original(method, params);
      if (method === 'cron.get') {
        ledger.records[0]!.pending = { kind: 'update', nativeHash: 'a'.repeat(64) };
        await store.write(ledger);
      }
      return response;
    };
    await assert.rejects(
      service.admit(manifest, root, 'check', ledger.records[0]!.hash),
      /execution-stale/,
    );
  });

  for (const observed of ['before', 'after'] as const)
    it(`should admit when migration completes around the ${observed} native read`, async () => {
      await service.reconcile(manifest, root);
      native[0]!.payload.outputMaxBytes = 16384;
      const { store } = await service.scope(manifest, root);
      const ledger = await store.read();
      ledger.records[0]!.nativeHash = nativeAutomationHash(native[0]!);
      await store.write(ledger);
      const original = service.dependencies.request!;
      let migrate = true;
      service.dependencies.request = async (method, params) => {
        if (method !== 'cron.get' || !migrate) return original(method, params);
        migrate = false;
        const before = observed === 'before' ? await original(method, params) : undefined;
        await service.reconcile(manifest, root);
        return before ?? original(method, params);
      };
      await service.admit(manifest, root, 'check', ledger.records[0]!.hash);
      assert.equal(native[0]!.payload.outputMaxBytes, 16777216);
      assert.equal((await store.read()).records[0]!.pending, undefined);
    });

  for (const completed of [false, true])
    it(`should recover an acknowledged-lost capture migration without replaying its update with completion ${completed}`, async () => {
      await service.reconcile(manifest, root);
      native[0]!.payload.outputMaxBytes = 12345;
      const { store } = await service.scope(manifest, root);
      const ledger = await store.read();
      ledger.records[0]!.nativeHash = nativeAutomationHash(native[0]!);
      await store.write(ledger);
      afterWriteFailure = true;
      await assert.rejects(service.reconcile(manifest, root));
      assert.equal(native[0]!.payload.outputMaxBytes, 16777216);
      assert.equal((await store.read()).records[0]!.pending?.kind, 'update');
      await service.admit(manifest, root, 'check', ledger.records[0]!.hash);
      if (completed) {
        native[0]!.enabled = false;
        native[0]!.state = { lastRunAtMs: now, lastRunStatus: 'ok' };
        await assert.rejects(
          service.admit(manifest, root, 'check', ledger.records[0]!.hash),
          /execution-drift/,
        );
      }
      const before = structuredClone(native[0]!);
      calls = [];
      await service.reconcile(manifest, root);
      assert.deepEqual(mutations(), []);
      assert.deepEqual(native[0], before);
      assert.equal((await store.read()).records[0]!.pending, undefined);
    });

  it('should relabel completed one-shots without rearming them or changing command hashes', async () => {
    await service.reconcile(manifest, root);
    native[0]!.state = { lastRunAtMs: now, lastRunStatus: 'ok' };
    await service.reconcile(manifest, root);
    const before = structuredClone(native[0]!);
    const { store } = await service.scope(manifest, root);
    const record = (await store.read()).records[0]!;
    for (const label of ['🔄 NIGHTLY REFRESH', '🔄 RENAMED', undefined]) {
      manifest.automations![0]!.displayName = label;
      assert.ok(
        (await service.inspect(manifest, root)).some(({ code }) => code === 'automation-drift'),
      );
      calls = [];
      await service.reconcile(manifest, root);
      assert.deepEqual(
        mutations().map(({ params }) => params.patch),
        [{ displayName: label ?? null }],
      );
      assert.deepEqual(native[0], {
        ...before,
        configRevision: native[0]!.configRevision,
        ...(label ? { displayName: label } : {}),
      });
      assert.equal(native.length, 1);
      assert.deepEqual((await store.read()).records[0]!.anchorMs, record.anchorMs);
      assert.equal((await store.read()).records[0]!.generation, record.generation);
      calls = [];
      await service.reconcile(manifest, root);
      assert.equal(mutations().length, 0);
    }
  });

  it('should pause and restore exact native settings without changing the installed receipt', async () => {
    await service.reconcile(manifest, root);
    const { store } = await service.scope(manifest, root);
    const before = await store.read();
    const snapshot = await service.notificationResetSnapshot(manifest, root, 'check');
    await service.notificationResetToggle(manifest, root, snapshot, false);
    assert.equal(native[0]!.enabled, false);
    await service.notificationResetToggle(manifest, root, snapshot, true);
    assert.equal(native[0]!.enabled, snapshot.enabled);
    assert.deepEqual(await store.read(), before);
    native[0]!.name = 'changed externally';
    await assert.rejects(
      service.notificationResetToggle(manifest, root, snapshot, false),
      /notification-reset-automation-changed/u,
    );
  });

  it('should defer offline install without synchronizing disabled jobs and later converge online', async () => {
    manifest.automations![0]!.enabled = false;
    const online = service.dependencies.request!;
    const offlineMethods: string[] = [];
    service.dependencies.request = createAutomationGateway(async (method) => {
      offlineMethods.push(method);
      throw Object.assign(new Error('secret connection details'), {
        name: 'GatewayTransportError',
        kind: 'closed',
        code: 1006,
        requestDispatched: false,
        connectionDetails: {},
      });
    });
    const otherWork: string[] = [];
    const install = new AgentInstallService({
      lifecycleRegistry: new AgentSystemLifecycleRegistry([
        {
          id: 'before',
          isConfigured: () => true,
          reconcile: async () => {
            otherWork.push('before');
            return { outcomes: [] };
          },
        },
        service.contribution(),
        {
          id: 'after',
          isConfigured: () => true,
          reconcile: async () => {
            otherWork.push('after');
            return { outcomes: [] };
          },
        },
      ]),
    });
    const input = { runtime: 'openclaw' as const, manifest, workspaceDir: root };
    const { store } = await service.scope(manifest, root);
    const before = await store.read();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await install.install(input);
      assert.equal(result.warnings[0]?.code, 'automation-sync-deferred');
      assert.deepEqual(
        result.outcomes
          .filter(({ component }) => component === 'automations')
          .map(({ code, status }) => ({ code, status })),
        [{ code: 'automation-sync-deferred', status: 'skipped' }],
      );
      assert.deepEqual(await store.read(), before);
      assert.equal(native.length, 0);
    }
    assert.deepEqual(otherWork, ['before', 'after', 'before', 'after']);
    assert.deepEqual(offlineMethods, ['cron.list', 'cron.list']);
    await assert.rejects(service.reconcile(manifest, root), {
      code: 'automation-gateway-unavailable',
    });
    service.dependencies.request = online;
    const synchronized = await install.install(input);
    assert.equal(synchronized.warnings.length, 0);
    assert.equal(
      synchronized.outcomes.find(({ component }) => component === 'automations')?.status,
      'created',
    );
    assert.equal(native[0]?.enabled, false);
    assert.ok(calls.some(({ method }) => method === 'cron.get'));
    calls = [];
    const repeated = await service.reconcile(manifest, root);
    assert.equal(repeated.outcomes[0]?.status, 'unchanged');
    assert.equal(mutations().length, 0);
    assert.ok(!calls.some(({ method }) => method === 'cron.run'));
  });

  it('should preserve existing jobs and ownership while install synchronization is deferred', async () => {
    await service.reconcile(manifest, root);
    const before = structuredClone(native);
    const { store } = await service.scope(manifest, root);
    const ledger = await store.read();
    manifest.automations = [];
    service.dependencies.request = createAutomationGateway(async () => {
      throw Object.assign(new Error('secret'), {
        name: 'GatewayTransportError',
        kind: 'timeout',
        requestDispatched: false,
        connectionDetails: {},
      });
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await service.contribution().reconcile!({ manifest, workspaceDir: root });
      assert.equal(result.warnings?.[0]?.code, 'automation-sync-deferred');
      assert.deepEqual(native, before);
      assert.deepEqual(await store.read(), ledger);
    }
  });

  it('should validate declarations before attempting offline scheduler discovery', async () => {
    let requests = 0;
    service.dependencies.request = createAutomationGateway(async () => {
      requests += 1;
      throw Object.assign(new Error('secret'), {
        name: 'GatewayTransportError',
        kind: 'timeout',
        requestDispatched: false,
        connectionDetails: {},
      });
    });
    manifest.automations![0]!.overrides.openclaw = { effort: 'unsupported' };
    await assert.rejects(service.contribution().reconcile!({ manifest, workspaceDir: root }), {
      code: 'automation-effort-unsupported',
    });
    assert.equal(requests, 0);
    assert.equal(native.length, 0);
  });

  it('should keep gateway auth rejection and unknown failures fatal during install', async () => {
    for (const [failure, code] of [
      [
        Object.assign(new Error('secret'), {
          name: 'GatewayClientRequestError',
          gatewayCode: 'FORBIDDEN',
          retryable: false,
        }),
        'automation-gateway-rejected',
      ],
      [
        Object.assign(new Error('secret'), { name: 'GatewayCredentialsRequiredError' }),
        'automation-gateway-failed',
      ],
      [
        Object.assign(new Error('secret'), {
          name: 'GatewayTransportError',
          kind: 'closed',
          code: 1008,
          requestDispatched: false,
          connectionDetails: {},
        }),
        'automation-gateway-failed',
      ],
      [
        Object.assign(new Error('secret'), {
          name: 'GatewayTransportError',
          kind: 'timeout',
          requestDispatched: true,
          connectionDetails: {},
        }),
        'automation-gateway-failed',
      ],
      [new Error('gateway unavailable: secret'), 'automation-gateway-failed'],
    ] as const) {
      service.dependencies.request = createAutomationGateway(async () => {
        throw failure;
      });
      await assert.rejects(
        service.contribution().reconcile!({ manifest, workspaceDir: root }),
        (error: unknown) => {
          assert.ok(error instanceof AgentSystemLifecycleError);
          assert.equal(error.code, code);
          assert.deepEqual(error.progress?.warnings, []);
          assert.deepEqual(error.progress?.outcomes, []);
          assert.ok(!JSON.stringify(error).includes('secret'));
          return true;
        },
      );
    }
    assert.equal(native.length, 0);
  });

  it('should keep ownership conflicts fatal during install without changing jobs', async () => {
    await service.reconcile(manifest, root);
    native[0]!.agentId = 'other';
    const before = structuredClone(native);
    calls = [];
    await assert.rejects(service.contribution().reconcile!({ manifest, workspaceDir: root }), {
      code: 'automation-ownership-conflict',
    });
    assert.deepEqual(native, before);
    assert.equal(mutations().length, 0);
  });

  it('should fail install on unavailable readback after a write and retain recovery state', async () => {
    const online = service.dependencies.request!;
    service.dependencies.request = createAutomationGateway(async (method, _options, params) => {
      if (method === 'cron.get')
        throw Object.assign(new Error('secret'), {
          name: 'GatewayTransportError',
          kind: 'timeout',
          requestDispatched: false,
          connectionDetails: {},
        });
      return online(method as Parameters<AutomationGateway>[0], params as Record<string, unknown>);
    });
    await assert.rejects(
      service.contribution().reconcile!({ manifest, workspaceDir: root }),
      (error: unknown) => {
        assert.ok(error instanceof AgentSystemLifecycleError);
        assert.equal(error.code, 'automation-gateway-unavailable');
        assert.deepEqual(error.progress?.warnings, []);
        return true;
      },
    );
    assert.equal(native.length, 1);
    assert.equal(native[0]?.enabled, false);
    const { store } = await service.scope(manifest, root);
    assert.equal((await store.read()).records[0]?.pending?.kind, 'create');
    service.dependencies.request = online;
    await service.reconcile(manifest, root);
    assert.equal(native.length, 1);
    assert.equal((await store.read()).records[0]?.pending, undefined);
  });

  it('should keep divergent readback fatal during install', async () => {
    const online = service.dependencies.request!;
    service.dependencies.request = async (method, params) => {
      const result = await online(method, params);
      return method === 'cron.get' ? { ...result, enabled: true } : result;
    };
    await assert.rejects(service.contribution().reconcile!({ manifest, workspaceDir: root }), {
      code: 'automation-readback-diverged',
    });
    assert.equal(native.length, 1);
    assert.equal(native[0]?.enabled, false);
  });

  it('should install the derived v2 job and group, detect drift and converge without duplicates', async () => {
    const sessions = new Map<string, Record<string, unknown>>();
    let saveCategory = true;
    const original = service.dependencies.request!;
    service.dependencies.request = async (method, params) => {
      if (!method.startsWith('sessions.')) return original(method, params);
      calls.push({ method, params: structuredClone(params) });
      const key = String(params.key ?? params.sessionId);
      if (method === 'sessions.resolve')
        return sessions.has(key) ? { ok: true, key, agentId: 'tanaabot' } : { ok: false };
      if (method === 'sessions.list') return { sessions: [...sessions.values()] };
      if (method === 'sessions.create') {
        assert.equal(params.cwd, root);
        sessions.set(key, {
          key,
          sessionId: 'intake-session',
          workspaceDir: root,
          model: params.model,
          thinkingLevel: params.thinkingLevel,
        });
        return { ok: true };
      }
      if (method === 'sessions.patch') {
        assert.equal(params.expectedSessionId, 'intake-session');
        const row = sessions.get(key)!;
        if (params.autoLabel)
          Object.assign(row, { autoLabel: params.autoLabel, displayName: params.autoLabel });
        if (params.category && saveCategory) row.category = params.category;
        return { ok: true };
      }
      throw Error('unexpected session operation');
    };
    const policy = { ...intakeFixture().policy, runtimes: ['openclaw' as const, 'codex' as const] };
    manifest.automations = [];
    manifest.models = {
      default: { model: 'openai/gpt-6-luna', effort: 'medium' },
      low: { model: 'openai/gpt-6-luna', effort: 'medium' },
      medium: { model: 'openai/gpt-6-luna', effort: 'medium' },
      high: { model: 'openai/gpt-6-luna', effort: 'high' },
    };
    manifest.github = { username: 'tanaabot', notifications: policy };
    await service.reconcile(manifest, root);
    assert.equal(native.length, 1);
    assert.equal(sessions.size, 1);
    assert.equal(native[0]!.enabled, true);
    assert.equal(native[0]!.name, 'AGENT SYSTEM: github-issue-assignment');
    assert.equal(native[0]!.displayName, '📥 ISSUE ASSIGNMENTS');
    assert.equal([...sessions.values()][0]!.displayName, 'ISSUE ASSIGNMENTS');
    assert.ok(native[0]!.trigger);
    assert.equal([...sessions.values()][0]!.category, 'AGENT SYSTEM');
    const identity = native[0]!.id;
    const coordinator = native[0]!.sessionTarget;
    const { store, context } = await service.scope(manifest, root);
    native[0]!.name = 'Agent System: github-issue-assignment';
    const legacy = await store.read();
    legacy.records[0]!.nativeHash = nativeAutomationHash(native[0]!);
    await store.write(legacy);
    const beforeRename = structuredClone(native[0]!);
    calls = [];
    await service.reconcile(manifest, root);
    assert.deepEqual(
      mutations().map(({ params }) => params.patch),
      [{ name: 'AGENT SYSTEM: github-issue-assignment' }],
    );
    const renamed: NativeAutomation = {
      ...beforeRename,
      name: 'AGENT SYSTEM: github-issue-assignment',
      configRevision: native[0]!.configRevision,
    };
    assert.deepEqual(native[0], renamed);
    calls = [];
    await service.reconcile(manifest, root);
    assert.deepEqual(mutations(), []);
    const ledger = await store.read();
    const oldJob = structuredClone(openclawIntakeJobs(manifest)[0]!);
    native[0]!.name = 'Agent System: github-issue-assignment';
    delete native[0]!.displayName;
    oldJob.payload = {
      kind: 'command',
      run: { kind: 'exec', executable: 'node', args: ['legacy-intake.js'] },
    };
    native[0]!.payload = {
      kind: 'command',
      argv: ['node', 'legacy-intake.js'],
      outputMaxBytes: 16384,
    };
    ledger.records[0]!.hash = effectiveAutomation(oldJob, context).hash;
    ledger.records[0]!.nativeHash = nativeAutomationHash(native[0]!);
    await store.write(ledger);
    calls = [];
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.id, identity);
    assert.equal(native[0]!.name, 'AGENT SYSTEM: github-issue-assignment');
    assert.equal(native[0]!.displayName, '📥 ISSUE ASSIGNMENTS');
    assert.equal(native[0]!.sessionTarget, coordinator);
    assert.equal(sessions.size, 1);
    assert.match(String(native[0]!.payload.message), /Fill initially available intake slots/);
    assert.equal(native[0]!.payload.kind, 'agentTurn');
    assert.equal(native[0]!.payload.outputMaxBytes, undefined);
    assert.equal(calls.filter((call) => call.method === 'cron.update').length, 1);
    calls = [];
    await service.reconcile(manifest, root);
    assert.equal(
      calls.some((c) =>
        ['cron.add', 'cron.update', 'sessions.create', 'sessions.patch'].includes(c.method),
      ),
      false,
    );
    policy.intervalMinutes = 10;
    const findings = await service.inspect(manifest, root);
    assert.ok(findings.some((f) => f.status === 'drift'));
    assert.equal(
      calls.some((c) =>
        ['cron.add', 'cron.update', 'sessions.create', 'sessions.patch'].includes(c.method),
      ),
      false,
    );
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.schedule.everyMs, 600000);
    assert.ok(native[0]!.trigger);
    policy.issueAssignment!.paused = true;
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.enabled, false);
    policy.issueAssignment!.paused = false;
    await service.reconcile(manifest, root);
    assert.equal(native.length, 1);
    assert.equal(native[0]!.id, identity);
    assert.equal(native[0]!.enabled, true);
    assert.equal(sessions.size, 1);
    policy.issueAssignment!.mode = 'work';
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.enabled, true);
    assert.equal(native[0]!.id, identity);
    policy.issueAssignment!.mode = 'plan';
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.enabled, true);
    assert.equal(native.length, 1);
    assert.equal(sessions.size, 1);
    const oldKey = String(native[0]!.sessionTarget).slice(8);
    sessions.get(oldKey)!.archived = true;
    const beforeRepair = calls.length;
    const broken = await service.inspect(manifest, root);
    assert.ok(broken.some((finding) => finding.code === 'automation-thread-replacement-required'));
    assert.ok(
      !calls
        .slice(beforeRepair)
        .some(({ method }) => ['sessions.create', 'cron.update'].includes(method)),
    );
    await service.reconcile(manifest, root);
    const installedKey = String(native[0]!.sessionTarget).slice(8);
    assert.notEqual(installedKey, oldKey);
    assert.equal(sessions.get(oldKey)!.archived, true);
    assert.equal(sessions.size, 2);
    const expected = await service.notificationResetSnapshot(
      manifest,
      root,
      'github-issue-assignment',
    );
    await service.notificationResetToggle(manifest, root, expected, false);
    sessions.get(installedKey)!.archived = true;
    let attempted = false;
    saveCategory = false;
    await assert.rejects(
      service.notificationResetReplace(manifest, root, expected, attempted, async () => {
        assert.fail('do not retarget the schedule before group readback');
      }),
      /automation-thread-readback-diverged/u,
    );
    assert.equal(native[0]!.enabled, false);
    assert.equal(native[0]!.sessionTarget, `session:${installedKey}`);
    assert.equal(sessions.size, 3);
    saveCategory = true;
    afterWriteFailure = true;
    await assert.rejects(
      service.notificationResetReplace(manifest, root, expected, attempted, async () => {
        attempted = true;
      }),
    );
    assert.equal(native[0]!.enabled, false);
    const replacement = await service.notificationResetReplace(
      manifest,
      root,
      expected,
      attempted,
      async () => {
        assert.fail('do not repeat uncertain update');
      },
    );
    assert.notEqual(replacement.sessionKey, installedKey);
    assert.equal(sessions.size, 3);
    assert.equal(sessions.get(replacement.sessionKey)!.category, 'AGENT SYSTEM');
    assert.equal(sessions.get(replacement.sessionKey)!.workspaceDir, root);
    assert.equal(
      await notificationAutomationReadiness(
        service,
        manifest,
        root,
        undefined,
        service.dependencies.request,
      ),
      'intake-automation-paused',
    );
    await service.notificationResetToggle(manifest, root, replacement, true);
    assert.equal(native[0]!.enabled, true);
    assert.equal(
      await notificationAutomationReadiness(
        service,
        manifest,
        root,
        undefined,
        service.dependencies.request,
      ),
      undefined,
    );
    assert.equal(
      (await service.inspect(manifest, root)).every((finding) => finding.status === 'healthy'),
      true,
    );
  });

  it('should create and update shared settings while preserving the native chat and schedule', async () => {
    const sessions = new Map<string, Record<string, unknown>>();
    const original = service.dependencies.request!;
    service.dependencies.request = async (method, params) => {
      if (!method.startsWith('sessions.')) return original(method, params);
      calls.push({ method, params: structuredClone(params) });
      const key = String(params.key ?? params.sessionId);
      if (method === 'sessions.resolve')
        return sessions.has(key) ? { ok: true, key, agentId: 'tanaabot' } : { ok: false };
      if (method === 'sessions.list') return { sessions: [...sessions.values()] };
      if (method === 'sessions.create') {
        sessions.set(key, {
          key,
          sessionId: 'same-chat',
          lifecycleRevision: 'revision-1',
          workspaceDir: root,
          model: params.model,
          thinkingLevel: params.thinkingLevel,
        });
        return { ok: true };
      }
      if (method === 'sessions.patch') {
        assert.equal(params.expectedSessionId, 'same-chat');
        if (params.model || params.thinkingLevel) {
          assert.deepEqual(params, {
            key,
            expectedSessionId: 'same-chat',
            expectedLifecycleRevision: 'revision-1',
            model: 'openai/gpt-6-luna',
            thinkingLevel: 'high',
          });
        }
        Object.assign(sessions.get(key)!, {
          ...(params.autoLabel ? { displayName: params.autoLabel } : {}),
          ...(params.category ? { category: params.category } : {}),
          ...(params.model ? { model: params.model } : {}),
          ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
        });
        return { ok: true };
      }
      throw new Error('unexpected session call');
    };
    manifest.models = { default: { model: 'openai/gpt-6-luna', effort: 'medium' } };
    manifest.automations = jobs([
      {
        id: 'prompt',
        schedule: 'every 1 hour',
        prompt: 'Check.',
        thread: { id: 'activity', name: 'Activity' },
      },
    ]);
    await service.reconcile(manifest, root);
    const [chat] = [...sessions.values()];
    assert.equal(chat?.thinkingLevel, 'medium');
    assert.equal(chat?.model, 'openai/gpt-6-luna');
    const id = native[0]!.id;
    const healthy = (await service.inspect(manifest, root)).find(
      ({ stepId }) => stepId === 'prompt',
    )!;
    assert.equal(healthy.status, 'healthy');
    assert.deepEqual(healthy.settings, {
      requested: { model: 'openai/gpt-6-luna', effort: 'medium' },
      observed: { model: 'openai/gpt-6-luna', effort: 'medium' },
    });
    for (const dimension of ['model', 'effort'] as const) {
      const field = dimension === 'model' ? 'model' : 'thinkingLevel';
      const previous = chat![field];
      chat![field] = dimension === 'model' ? 'openai/other' : 'low';
      calls = [];
      const [drift] = await service.inspect(manifest, root);
      assert.equal(drift?.stepId, 'prompt');
      assert.equal(drift?.code, 'automation-thread-model-drift');
      assert.equal(drift?.status, 'blocked');
      assert.deepEqual(drift?.settings, {
        requested: { model: 'openai/gpt-6-luna', effort: 'medium' },
        observed: { model: 'openai/gpt-6-luna', effort: 'medium', [dimension]: chat![field] },
      });
      assert.equal(
        calls.some(({ method }) =>
          ['sessions.patch', 'sessions.create', 'cron.update'].includes(method),
        ),
        false,
      );
      assert.equal(chat![field], dimension === 'model' ? 'openai/other' : 'low');
      chat![field] = previous;
    }
    const name = chat!.displayName;
    chat!.displayName = 'Other';
    const [nameDrift] = await service.inspect(manifest, root);
    assert.equal(nameDrift?.stepId, 'prompt');
    assert.equal(nameDrift?.code, 'automation-thread-name-drift');
    chat!.displayName = name;
    manifest.models.default.effort = 'high';
    calls = [];
    const findings = await service.inspect(manifest, root);
    assert.ok(
      findings.some(({ message }) => message.includes('high') && message.includes('medium')),
    );
    assert.equal(
      calls.some(({ method }) => method === 'sessions.patch'),
      false,
    );
    await service.reconcile(manifest, root);
    assert.equal(sessions.size, 1);
    assert.equal(chat?.thinkingLevel, 'high');
    assert.equal(native[0]!.id, id);
    assert.equal(native[0]!.payload.thinking, 'high');
    assert.equal(
      calls.some(({ method }) => method === 'sessions.create'),
      false,
    );
    calls = [];
    await service.reconcile(manifest, root);
    assert.equal(
      calls.some(({ method }) => ['sessions.patch', 'cron.update'].includes(method)),
      false,
    );
  });

  it('should preserve unowned chat settings and schedule when only workspace defaults change', async () => {
    const original = service.dependencies.request!;
    const key = 'agent:tanaabot:existing';
    service.dependencies.request = async (method, params) => {
      if (!method.startsWith('sessions.')) return original(method, params);
      calls.push({ method, params });
      if (method === 'sessions.resolve') return { ok: true, key, agentId: 'tanaabot' };
      if (method === 'sessions.list')
        return {
          sessions: [
            {
              key,
              sessionId: 'existing',
              workspaceDir: root,
              category: 'AGENT SYSTEM',
              model: 'openai/native',
              thinkingLevel: 'low',
            },
          ],
        };
      assert.fail('unowned chat must not receive a session mutation');
    };
    manifest.models = { default: { model: 'openai/default', effort: 'medium' } };
    manifest.automations = jobs([
      {
        id: 'prompt',
        schedule: 'every 1 hour',
        prompt: 'Check.',
        overrides: { openclaw: { target: { thread: key } } },
      },
    ]);
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.payload.model, undefined);
    assert.equal(native[0]!.payload.thinking, undefined);
    const before = structuredClone(native);
    manifest.models.default = { model: 'openai/changed', effort: 'high' };
    calls = [];
    await service.reconcile(manifest, root);
    assert.deepEqual(native, before);
    assert.ok(
      !calls.some(({ method }) =>
        ['sessions.create', 'sessions.patch', 'cron.update'].includes(method),
      ),
    );
  });

  it('should share a native session, preserve history across routing changes, and recover a lost create response', async () => {
    const sessions = new Map<string, Record<string, unknown>>();
    const original = service.dependencies.request!;
    let loseResponse = true;
    service.dependencies.request = async (method, params) => {
      if (!method.startsWith('sessions.')) return original(method, params);
      calls.push({ method, params: structuredClone(params) });
      const key = String(params.key ?? params.sessionId);
      if (method === 'sessions.resolve')
        return sessions.has(key) ? { ok: true, key, agentId: 'tanaabot' } : { ok: false };
      if (method === 'sessions.list') return { sessions: [...sessions.values()] };
      if (method === 'sessions.create') {
        assert.equal(Object.hasOwn(params, 'idempotencyKey'), false);
        assert.equal(params.agentId, 'tanaabot');
        assert.equal(params.cwd, root);
        assert.match(key, /^agent:tanaabot:automation:/u);
        sessions.set(key, { key, sessionId: 'durable-id', workspaceDir: root });
        if (loseResponse) {
          loseResponse = false;
          throw new Error('lost create response');
        }
        return { ok: true };
      }
      if (method === 'sessions.patch') {
        assert.equal(params.expectedSessionId, 'durable-id');
        Object.assign(sessions.get(key)!, {
          ...(params.autoLabel !== undefined
            ? { autoLabel: params.autoLabel, displayName: params.autoLabel }
            : {}),
          ...(params.category !== undefined ? { category: params.category } : {}),
        });
        return { ok: true };
      }
      throw new Error('unexpected session call');
    };
    manifest.automations = jobs(
      ['builds', 'reviews'].map((id) => ({
        id,
        prompt: 'Check.',
        schedule: 'every 1 hour',
        thread: { id: 'activity', name: 'Activity' },
      })),
    );
    await assert.rejects(service.reconcile(manifest, root));
    assert.equal(native.length, 0);
    await service.reconcile(manifest, root);
    assert.equal(sessions.size, 1);
    assert.equal(calls.filter((call) => call.method === 'sessions.create').length, 1);
    assert.equal(native.length, 2);
    assert.equal(native[0]?.sessionTarget, native[1]?.sessionTarget);
    assert.match(String(native[0]?.sessionTarget), /^session:agent:tanaabot:/);
    const nativeIds = native.map((job) => job.id);
    const originalJob = structuredClone(native[0]!);
    const originalSessions = structuredClone(sessions);
    for (const label of ['🔄 NIGHTLY REFRESH', '🔄 RENAMED', undefined]) {
      manifest.automations[0]!.displayName = label;
      calls = [];
      await service.reconcile(manifest, root);
      assert.deepEqual(
        mutations().map(({ params }) => params.patch),
        [{ displayName: label ?? null }],
      );
      assert.deepEqual(native[0], {
        ...originalJob,
        configRevision: native[0]!.configRevision,
        ...(label ? { displayName: label } : {}),
      });
      assert.deepEqual(sessions, originalSessions);
      assert.equal(native.length, 2);
    }
    const before = calls.length;
    await service.reconcile(manifest, root);
    assert.equal(
      calls
        .slice(before)
        .filter((call) =>
          ['sessions.create', 'sessions.patch', 'cron.add', 'cron.update'].includes(call.method),
        ).length,
      0,
    );
    manifest.automations[0]!.overrides.openclaw = { target: 'independent' };
    await service.reconcile(manifest, root);
    assert.equal(native[0]?.sessionTarget, 'isolated');
    assert.deepEqual(
      native.map((job) => job.id),
      nativeIds,
    );
    assert.equal(sessions.size, 1);
    delete manifest.automations[0]!.overrides.openclaw;
    await service.reconcile(manifest, root);
    assert.equal(native[0]?.sessionTarget, native[1]?.sessionTarget);
  });

  it('should preserve safe gateway evidence through reconciliation failure wrapping', async () => {
    service.dependencies.request = createAutomationGateway(async () => {
      throw Object.assign(new Error('secret payload'), {
        name: 'GatewayClientRequestError',
        gatewayCode: 'FORBIDDEN',
        retryable: false,
        details: 'secret',
      });
    });
    await assert.rejects(service.reconcile(manifest, root), (error: unknown) => {
      assert.ok(error instanceof AgentSystemLifecycleError);
      assert.ok(error.cause instanceof AutomationError);
      assert.equal(error.cause.diagnostic?.category, 'rejected');
      assert.equal(error.cause.diagnostic.gatewayCode, 'FORBIDDEN');
      assert.deepEqual(error.progress?.unattempted, [{ component: 'automations' }]);
      assert.ok(!JSON.stringify(error).includes('secret'));
      return true;
    });
  });

  it('should keep inventory rows and findings on the same ownership snapshot during concurrent sync', async () => {
    await service.reconcile(manifest, root);
    const { store } = await service.scope(manifest, root);
    const ledger = await store.read();
    const request = service.dependencies.request!;
    service.dependencies.request = async (method, params) => {
      const result = await request(method, params);
      if (method === 'cron.list') {
        ledger.records[0]!.pending = { kind: 'update', nativeHash: ledger.records[0]!.nativeHash! };
        await store.write(ledger);
      }
      return result;
    };
    const result = await service.list(manifest, root);
    assert.equal(result.status, 'aligned');
    assert.equal(result.jobs[0]!.nativeId, native[0]!.id);
    assert.equal(result.jobs[0]!.findings[0]!.code, 'automation-healthy');
    assert.equal((await store.read()).records[0]!.pending!.kind, 'update');
  });

  it('should list declared and native state and queue an exact owned job with separate history', async () => {
    await service.reconcile(manifest, root);
    calls = [];
    const listed = await service.list(manifest, root);
    assert.equal(listed.jobs[0]!.nativeId, native[0]!.id);
    assert.equal(listed.jobs[0]!.nativeEnabled, true);
    assert.equal(calls.filter(({ method }) => method === 'cron.list').length, 1);
    assert.equal(mutations().length, 0);
    const run = await service.run(manifest, root, 'check');
    assert.equal(run.status, 'queued');
    assert.equal(run.runId, 'run-1');
    assert.equal(run.execution, 'unavailable');
    assert.deepEqual(calls.find(({ method }) => method === 'cron.run')!.params, {
      id: native[0]!.id,
      mode: 'if-enabled',
    });
    const history = await service.runs(manifest, root, 'check', {
      limit: 10,
      offset: 0,
      runId: 'run-1',
    });
    assert.equal(history.entries[0]!.execution, 'ok');
    assert.equal(history.entries[0]!.delivery, 'not-delivered');
    assert.ok(!JSON.stringify(history).includes('secret'));
    assert.deepEqual(calls.find(({ method }) => method === 'cron.runs')!.params, {
      id: native[0]!.id,
      limit: 10,
      offset: 0,
      runId: 'run-1',
    });
    manifest.automations = [];
    await service.reconcile(manifest, root);
    assert.equal((await service.list(manifest, root)).jobs[0]!.removed, true);
    assert.equal(
      (await service.runs(manifest, root, 'check', { limit: 10, offset: 0 })).entries.length,
      1,
    );
  });
  it('should reject missing disabled drifted consumed and cross-owner runs before admission', async () => {
    await service.reconcile(manifest, root);
    await assert.rejects(service.run(manifest, root, 'missing'), /id-missing/u);
    const original = structuredClone(manifest);
    manifest.automations![0]!.enabled = false;
    await assert.rejects(service.run(manifest, root, 'check'), /run-disabled/u);
    manifest = structuredClone(original);
    manifest.automations![0]!.payload = { kind: 'prompt', prompt: 'changed' };
    await assert.rejects(service.run(manifest, root, 'check'), /execution-drift/u);
    manifest = structuredClone(original);
    native[0]!.state = { lastRunAtMs: now, lastRunStatus: 'ok' };
    await assert.rejects(service.run(manifest, root, 'check'), /run-disabled/u);
    native[0]!.state = {};
    native[0]!.agentId = 'another-agent';
    await assert.rejects(service.run(manifest, root, 'check'), /ownership-conflict/u);
    assert.equal(calls.filter(({ method }) => method === 'cron.run').length, 0);
  });
  it('should keep job-wide report state separate from native history without exposing captured output', async () => {
    await service.reconcile(manifest, root);
    const { store } = await service.scope(manifest, root);
    const ledger = await store.read();
    const executionId = randomUUID();
    const report = {
      version: 1 as const,
      executionId,
      hash: ledger.records[0]!.hash,
      manifestDigest: 'fixture',
      target: {
        scope: store.scope,
        agentId: 'tanaabot',
        workspaceDir: root,
        sessionKey: 'agent:tanaabot:reports',
      },
      input: prepareAutomationReport({
        id: 'check',
        executionId,
        startedAt: '2026-10-30T00:00:00Z',
        cancelled: false,
        result: {
          exitCode: 17,
          timedOut: false,
          truncated: false,
          output: { stdout: 'private output', stderr: '' },
        },
      }),
      state: 'pending' as const,
    };
    await service.reports.withLock(executionId, () => service.reports.write(report));
    await service.assertReportCurrent(report);
    manifestDigest = 'unrelated-edit';
    await service.assertReportCurrent(report);
    const original = structuredClone(manifest);
    for (const change of [
      'removed',
      'disabled',
      'command',
      'runtime',
      'schedule',
      'report-target',
    ] as const) {
      manifest = structuredClone(original);
      if (change === 'removed') manifest.automations = [];
      if (change === 'disabled') manifest.automations![0]!.enabled = false;
      if (change === 'command')
        manifest.automations![0]!.payload = { kind: 'prompt', prompt: 'changed' };
      if (change === 'runtime') manifest.automations![0]!.runtimes = ['codex'];
      if (change === 'schedule')
        manifest.automations![0]!.schedule = jobs([
          { id: 'check', schedule: 'every 2 hours', run: ['gh', 'api', 'user'] },
        ])[0]!.schedule;
      if (change === 'report-target')
        manifest.automations = jobs([
          {
            id: 'check',
            schedule: 'in 1 hour',
            run: ['gh', 'api', 'user'],
            thread: { name: 'another destination' },
          },
        ]);
      await assert.rejects(service.assertReportCurrent(report), /declaration-changed/u);
    }
    manifest = original;
    const history = await service.runs(manifest, root, 'check', {
      limit: 10,
      offset: 0,
      runId: 'run-1',
    });
    assert.equal(history.reportsTotal, 1);
    assert.equal(history.reports[0]!.executionId, executionId);
    assert.equal(history.reports[0]!.execution, 'error');
    assert.equal(history.reports[0]!.status, 'pending');
    assert.equal(history.entries[0]!.execution, 'ok');
    assert.ok(!JSON.stringify(history).includes('private output'));
    loaded = false;
    await assert.rejects(service.assertReportCurrent(report), /declaration-changed/);
  });

  it('should reject invalid history options and report transport failure without replay', async () => {
    await service.reconcile(manifest, root);
    for (const options of [
      { limit: 201, offset: 0 },
      { limit: 1, offset: -1 },
      { limit: 1, offset: 0, runId: '' },
    ])
      await assert.rejects(
        service.runs(manifest, root, 'check', options),
        /history-options-invalid/u,
      );
    fail = 'cron.run';
    await assert.rejects(service.run(manifest, root, 'check'));
    assert.equal(calls.filter(({ method }) => method === 'cron.run').length, 1);
  });
  it('should create disabled, acknowledge ownership, activate and leave unchanged sync write-free', async () => {
    await service.reconcile(manifest, root);
    assert.equal(native.length, 1);
    assert.equal(mutations()[0]!.params.enabled, false);
    assert.deepEqual(mutations()[1]!.params.patch, { enabled: true });
    const { store } = await service.scope(manifest, root);
    const before = (await stat(store.path)).mtimeMs;
    calls = [];
    now += 99_000;
    await service.reconcile(manifest, root);
    assert.equal(mutations().length, 0);
    assert.equal((await stat(store.path)).mtimeMs, before);
    assert.equal((await service.inspect(manifest, root))[0]!.code, 'automation-healthy');
    assert.equal(native[0]!.payload.kind, 'command');
    assert.equal(native[0]!.payload.cwd, root);
    assert.equal(native[0]!.deleteAfterRun, false);
    assert.ok((native[0]!.payload.argv as string[]).includes('automation-execute'));
  });
  it('should retain one-shot anchors across payload edits removal reintroduction and completion', async () => {
    await service.reconcile(manifest, root);
    const at = native[0]!.schedule.at;
    manifest.automations![0]!.payload = {
      kind: 'command',
      run: { kind: 'exec', executable: 'git', args: ['status'] },
    };
    now += 600_000;
    calls = [];
    await service.reconcile(manifest, root);
    assert.ok(mutations().every(({ params }) => !('schedule' in (params.patch as object))));
    const declarations = manifest.automations;
    delete manifest.automations;
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.enabled, false);
    manifest.automations = declarations;
    await service.reconcile(manifest, root);
    assert.equal(native.length, 1);
    assert.equal(native[0]!.schedule.at, at);
    native[0]!.enabled = false;
    native[0]!.state = { lastRunStatus: 'ok', lastRunAtMs: now };
    calls = [];
    await service.reconcile(manifest, root);
    assert.equal(mutations().length, 0);
    assert.equal((await service.inspect(manifest, root))[0]!.code, 'automation-completed');
    manifest.automations![0]!.schedule = { kind: 'in', seconds: 7200, missedRun: 'native' };
    await service.reconcile(manifest, root);
    assert.notEqual(native[0]!.schedule.at, at);
    assert.equal(native[0]!.enabled, true);
  });
  it('should retain history when a consumed one-shot becomes recurring and then one-shot again', async () => {
    await service.reconcile(manifest, root);
    const id = native[0]!.id;
    native[0]!.state = { lastRunAtMs: now, lastRunStatus: 'ok' };
    native[0]!.enabled = false;
    manifest.automations![0]!.schedule = { kind: 'every', seconds: 3600, missedRun: 'native' };
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.id, id);
    assert.equal(native[0]!.enabled, true);
    assert.equal(native[0]!.deleteAfterRun, false);
    assert.equal(native[0]!.state.lastRunStatus, 'ok');
    manifest.automations![0]!.schedule = { kind: 'in', seconds: 7200, missedRun: 'native' };
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.id, id);
    assert.equal(native[0]!.deleteAfterRun, false);
  });

  it('should recover a successful create with a lost acknowledgement without duplication', async () => {
    afterWriteFailure = true;
    await assert.rejects(service.reconcile(manifest, root));
    assert.equal(native.length, 1);
    assert.equal(native[0]!.enabled, false);
    calls = [];
    now += 5_000;
    await service.reconcile(manifest, root);
    assert.equal(native.length, 1);
    assert.equal(native[0]!.enabled, true);
    assert.equal(calls.filter(({ method }) => method === 'cron.add').length, 0);
  });
  it('should resume a pending update after native success without replaying it', async () => {
    await service.reconcile(manifest, root);
    manifest.automations![0]!.timeoutSeconds = 120;
    afterWriteFailure = true;
    await assert.rejects(service.reconcile(manifest, root));
    calls = [];
    await service.reconcile(manifest, root);
    assert.equal(mutations().length, 0);
  });
  it('should retain uncertain creates on removal and reuse the acknowledged id on reintroduction', async () => {
    afterWriteFailure = true;
    await assert.rejects(service.reconcile(manifest, root));
    const declarations = manifest.automations;
    delete manifest.automations;
    await service.reconcile(manifest, root);
    manifest.automations = declarations;
    await service.reconcile(manifest, root);
    const { store } = await service.scope(manifest, root);
    const record = (await store.read()).records[0]!;
    assert.equal(record.nativeId, native[0]!.id);
    await service.admit(manifest, root, 'check', record.hash);
    assert.equal(native.length, 1);
  });
  it('should serialize concurrent reconcilers without duplicate jobs', async () => {
    await Promise.all([service.reconcile(manifest, root), service.reconcile(manifest, root)]);
    assert.equal(native.length, 1);
    assert.equal(calls.filter(({ method }) => method === 'cron.add').length, 1);
  });
  for (const disableFirst of [true, false]) {
    it(`should retire deleted undeclared jobs ${disableFirst ? 'after' : 'before'} removal sync`, async () => {
      manifest.automations!.push(
        ...jobs([{ id: 'unrelated', schedule: 'every 2 hours', run: ['true'] }]),
      );
      await service.reconcile(manifest, root);
      const unrelated = structuredClone(native[1]!);
      if (!disableFirst) {
        const { store } = await service.scope(manifest, root);
        const legacy = await store.read();
        delete legacy.records.find(({ id }) => id === 'check')!.nativeHash;
        await store.write(legacy);
      }
      manifest.automations = manifest.automations!.filter(({ id }) => id !== 'check');
      if (disableFirst) await service.reconcile(manifest, root);
      native = native.filter(({ id }) => id !== 'native-0');
      calls = [];
      assert.equal(
        (await service.inspect(manifest, root)).find(({ stepId }) => stepId === 'check')!.code,
        'automation-retirement-pending',
      );
      assert.equal(mutations().length, 0);
      await service.reconcile(manifest, root);
      const { store } = await service.scope(manifest, root);
      const ledger = await store.read();
      const record = ledger.records.find(({ id }) => id === 'check')!;
      const retiredAtMs = record.retired!.atMs;
      assert.equal(record.removed, true);
      assert.deepEqual(record.retired, { atMs: now, reason: 'native-job-absent' });
      assert.equal(record.nativeId, 'native-0');
      assert.equal(Boolean(record.nativeHash), disableFirst);
      assert.equal(
        (await service.inspect(manifest, root)).find(({ stepId }) => stepId === 'check')!.code,
        'automation-retired',
      );
      assert.equal(
        (await service.inspect(manifest, root)).some(({ status }) => status === 'blocked'),
        false,
      );
      assert.deepEqual(native, [unrelated]);
      assert.equal(mutations().length, 0);
      const bytes = await store.file.read();

      now += 24 * 60 * 60 * 1000 - 1;
      assert.equal(
        (await service.inspect(manifest, root)).some(({ code }) => code === 'automation-retired'),
        true,
      );
      assert.equal(
        (await service.reconcile(manifest, root)).outcomes.some(
          ({ code, stepId }) => code === 'automation-retired' && stepId === 'check',
        ),
        true,
      );

      now += 1;
      assert.equal(
        (await service.inspect(manifest, root)).some(({ code }) => code === 'automation-retired'),
        false,
      );
      assert.equal(
        (await service.reconcile(manifest, root)).outcomes.some(
          ({ code, stepId }) => code === 'automation-retired' && stepId === 'check',
        ),
        false,
      );

      now += 1;
      assert.equal(
        (await service.inspect(manifest, root)).some(({ code }) => code === 'automation-retired'),
        false,
      );
      assert.equal(
        (await service.list(manifest, root)).jobs.find(({ id }) => id === 'check')!.retired,
        true,
      );
      assert.deepEqual(await store.read(), ledger);
      assert.equal(await store.file.read(), bytes);
      assert.deepEqual(record.retired, { atMs: retiredAtMs, reason: 'native-job-absent' });
      assert.equal(record.nativeId, 'native-0');
      await service.reconcile(manifest, root);
      assert.deepEqual(await store.read(), ledger);
      assert.equal(await store.file.read(), bytes);
      assert.equal(mutations().length, 0);
    });
  }

  it('should refuse retired identity reuse and native reappearance without executing historical jobs', async () => {
    await service.reconcile(manifest, root);
    const declarations = manifest.automations;
    const saved = structuredClone(native[0]!);
    delete manifest.automations;
    native = [];
    await service.reconcile(manifest, root);
    const { store } = await service.scope(manifest, root);
    const ledger = await store.read();
    now += 24 * 60 * 60 * 1000 + 1;
    calls = [];
    manifest.automations = declarations;
    await assert.rejects(service.reconcile(manifest, root), /automation-retired-id/u);
    assert.equal((await service.inspect(manifest, root))[0]!.code, 'automation-retired-id');
    await assert.rejects(
      service.admit(manifest, root, 'check', ledger.records[0]!.hash),
      /execution-stale/u,
    );
    await assert.rejects(
      service.runs(manifest, root, 'check', { limit: 1, offset: 0 }),
      /owned-job-missing/u,
    );
    await assert.rejects(
      service.notificationResetSnapshot(manifest, root, 'check'),
      /owned-job-missing/u,
    );
    delete manifest.automations;
    for (const job of [
      saved,
      { ...saved, id: 'replacement' },
      { ...saved, declarationKey: 'other-marker' },
    ]) {
      native = [job];
      await assert.rejects(service.reconcile(manifest, root), /ownership-conflict/u);
      assert.equal(
        (await service.inspect(manifest, root))[0]!.code,
        'automation-ownership-conflict',
      );
    }
    assert.deepEqual(await store.read(), ledger);
    assert.equal(
      calls.some(({ method }) =>
        ['cron.add', 'cron.update', 'cron.run', 'cron.runs', 'cron.get'].includes(method),
      ),
      false,
    );
  });

  for (const pending of ['create', 'update'] as const) {
    it(`should preserve unresolved ${pending} evidence after native deletion and declaration removal`, async () => {
      await service.reconcile(manifest, root);
      const { store } = await service.scope(manifest, root);
      const ledger = await store.read();
      ledger.records[0]!.pending = { kind: pending, nativeHash: 'a'.repeat(64) };
      if (pending === 'create') delete ledger.records[0]!.nativeId;
      await store.write(ledger);
      delete manifest.automations;
      native = [];
      calls = [];
      await assert.rejects(
        service.reconcile(manifest, root),
        /automation-(?:native-job-missing|recovery-required)/u,
      );
      assert.deepEqual(await store.read(), ledger);
      assert.equal(
        (await service.inspect(manifest, root))[0]!.code,
        'automation-recovery-required',
      );
      assert.equal(mutations().length, 0);
    });
  }

  for (const failure of [
    'restricted',
    'filtered-operator',
    'unknown-count',
    'changed-count',
    'failed',
    'incomplete',
    'reappeared',
    'conflicted',
    'manifest-changed',
    'redeclaration-during-inspection',
  ] as const) {
    it(`should retain undeclared ownership when inspection is ${failure}`, async () => {
      await service.reconcile(manifest, root);
      const saved = structuredClone(native[0]!);
      const { store } = await service.scope(manifest, root);
      const before = await store.read();
      const declarations = manifest.automations;
      delete manifest.automations;
      native = [];
      if (failure === 'reappeared' || failure === 'conflicted')
        native = [{ ...saved, id: 'external', declarationKey: 'external' }];
      calls = [];
      const original = service.dependencies.request!;
      let lists = 0;
      let statuses = 0;
      const inspect: AutomationGateway = async (method, params) => {
        if (method === 'cron.status') {
          statuses += 1;
          if (failure === 'filtered-operator') return { enabled: true, jobs: 1 };
          if (failure === 'changed-count') return { enabled: true, jobs: statuses === 1 ? 0 : 1 };
          if (failure === 'unknown-count') return { enabled: true };
        }
        if (method === 'cron.list') {
          lists += 1;
          if (failure === 'failed') throw new Error('inspection failed');
          if (failure === 'incomplete') return { jobs: [], hasMore: true };
          if (failure === 'redeclaration-during-inspection' && lists === 2)
            manifest.automations = declarations;
          if (lists === 3) {
            if (failure === 'reappeared') native = [saved];
            if (failure === 'conflicted') native = [{ ...saved, agentId: 'other' }];
            if (failure === 'manifest-changed') loaded = false;
          }
        }
        return original(method, params);
      };
      service.dependencies.request =
        failure === 'restricted'
          ? inspect
          : createAutomationGateway(async (method, _options, params) =>
              inspect(
                method as Parameters<AutomationGateway>[0],
                params as Record<string, unknown>,
              ),
            );
      await assert.rejects(
        service.reconcile(manifest, root),
        new RegExp(
          ['restricted', 'filtered-operator', 'unknown-count', 'changed-count'].includes(failure)
            ? 'inspection-incomplete'
            : failure === 'conflicted'
              ? 'ownership-conflict'
              : failure === 'manifest-changed' || failure === 'redeclaration-during-inspection'
                ? 'manifest-changed'
                : failure === 'failed'
                  ? 'gateway-failed'
                  : 'snapshot-diverged',
          'u',
        ),
      );
      if (failure === 'restricted') {
        assert.equal(
          (await service.inspect(manifest, root))[0]!.code,
          'automation-inspection-incomplete',
        );
      }
      assert.deepEqual(await store.read(), before);
      assert.equal(mutations().length, 0);
    });
  }

  it('should retain the old receipt when retirement cannot be persisted and recover on retry', async () => {
    await service.reconcile(manifest, root);
    delete manifest.automations;
    native = [];
    const scope = await service.scope(manifest, root);
    const before = await scope.store.read();
    const write = scope.store.write.bind(scope.store);
    scope.store.write = async () => {
      throw new Error('unavailable storage');
    };
    service.scope = async () => scope;
    await assert.rejects(service.reconcile(manifest, root), /automation-reconcile-failed/u);
    assert.deepEqual(await scope.store.read(), before);
    scope.store.write = write;
    await service.reconcile(manifest, root);
    assert.ok((await scope.store.read()).records[0]!.retired);
  });

  it('should reject incompatible retirement records without upgrading legacy removed state', async () => {
    await service.reconcile(manifest, root);
    const { store } = await service.scope(manifest, root);
    const legacy = await store.read();
    legacy.records[0]!.removed = true;
    await store.write(legacy);
    assert.equal((await store.read()).records[0]!.retired, undefined);
    for (const malformed of [
      { ...legacy.records[0], removed: false },
      { ...legacy.records[0], nativeId: undefined },
      { ...legacy.records[0], pending: { kind: 'create', nativeHash: 'a'.repeat(64) } },
    ]) {
      await store.file.write(
        JSON.stringify({
          ...legacy,
          records: [{ ...malformed, retired: { atMs: now, reason: 'native-job-absent' } }],
        }),
      );
      await assert.rejects(store.read(), /ownership-invalid/u);
    }
  });

  it('should reject missing native jobs missing ownership and cross-agent marker collisions', async () => {
    await service.reconcile(manifest, root);
    const saved = native[0]!;
    native = [];
    await assert.rejects(service.reconcile(manifest, root), /automation-native-job-missing/u);
    native = [saved];
    saved.agentId = 'other';
    await assert.rejects(service.reconcile(manifest, root), /automation-ownership-conflict/u);
    saved.agentId = 'tanaabot';
    const { store } = await service.scope(manifest, root);
    await store.file.remove();
    calls = [];
    await assert.rejects(service.reconcile(manifest, root), /automation-ownership-missing/u);
    assert.equal(mutations().length, 0);
  });
  it('should report drift without writes and restore owned native edits with revisions', async () => {
    await service.reconcile(manifest, root);
    native[0]!.payload.timeoutSeconds = 10;
    native[0]!.delivery = { mode: 'webhook', to: 'https://example.invalid', bestEffort: true };
    native[0]!.trigger = { script: 'return true' };
    native[0]!.configRevision = String(++revision);
    calls = [];
    assert.equal((await service.inspect(manifest, root))[0]!.code, 'automation-drift');
    assert.equal(mutations().length, 0);
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.payload.timeoutSeconds, 1800);
    assert.deepEqual(native[0]!.delivery, { mode: 'none', bestEffort: false });
    assert.equal(native[0]!.trigger, undefined);
    assert.ok(mutations().every(({ params }) => typeof params.expectedConfigRevision === 'string'));
  });
  it('should preserve native safety disable and ambiguous one-shot recovery', async () => {
    await service.reconcile(manifest, root);
    native[0]!.state = { autoDisabled: { reason: 'schedule' } };
    calls = [];
    await assert.rejects(service.reconcile(manifest, root), /automation-native-safety-disabled/u);
    assert.equal(mutations().length, 0);
    native[0]!.state = { lastRunAtMs: now, lastRunStatus: 'error' };
    await assert.rejects(service.reconcile(manifest, root), /automation-one-shot-state-ambiguous/u);
    native[0]!.state.nextRunAtMs = now + 1000;
    await service.reconcile(manifest, root);
    assert.equal(mutations().length, 0);
  });
  it('should leave unmanaged jobs alone and validate all declarations before writes', async () => {
    native.push({
      id: 'unmanaged',
      declarationKey: 'another-plugin:job',
      agentId: 'other',
      enabled: true,
      configRevision: 'unmanaged',
      schedule: {},
      payload: {},
      state: {},
    });
    manifest.automations!.push(
      ...jobs([
        {
          id: 'unsupported',
          schedule: 'every 1 hour',
          prompt: 'hi',
          overrides: { openclaw: { target: { thread: 'missing' } } },
        },
      ]),
    );
    await assert.rejects(service.reconcile(manifest, root), /automation-thread-missing/u);
    assert.equal(mutations().length, 0);
    manifest.automations!.pop();
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.configRevision, 'unmanaged');
  });
  it('should deny stale disabled changed and native-drifted executions before command authority', async () => {
    await service.reconcile(manifest, root);
    const { store } = await service.scope(manifest, root);
    const hash = (await store.read()).records[0]!.hash;
    assert.equal((await service.admit(manifest, root, 'check', hash)).command.kind, 'exec');
    await assert.rejects(service.admit(manifest, root, 'check', '0'.repeat(64)), /stale/u);
    manifest.automations![0]!.enabled = false;
    await assert.rejects(service.admit(manifest, root, 'check', hash), /stale/u);
    manifest.automations![0]!.enabled = true;
    native[0]!.payload.env = { GH_TOKEN: 'operator-secret' };
    await assert.rejects(service.admit(manifest, root, 'check', hash), /drift/u);
  });
  it('should keep non-operator lifecycle calls free of rpc and state writes', async () => {
    const passive = new AutomationService({ ...service.dependencies, request: undefined });
    assert.equal(
      (await passive.inspect(manifest, root))[0]!.code,
      'automation-requires-operator-sync',
    );
    assert.equal(
      (await passive.reconcile(manifest, root)).warnings![0]!.code,
      'automation-requires-operator-sync',
    );
    assert.equal(calls.length, 0);
    const { store } = await service.scope(manifest, root);
    await assert.rejects(stat(store.path));
  });
  it('should preserve verified partial sync progress and recover without replaying earlier writes', async () => {
    manifest.automations = jobs([
      { id: 'first', schedule: 'every 1 hour', run: ['true'] },
      { id: 'second', schedule: 'every 1 hour', run: ['true'] },
    ]);
    fail = 'second-add';
    await assert.rejects(service.reconcile(manifest, root), (error: unknown) => {
      assert.ok(error instanceof AgentSystemLifecycleError);
      assert.equal(error.progress!.outcomes[0]!.stepId, 'first');
      assert.equal(error.progress!.outcomes[0]!.status, 'created');
      assert.ok(!JSON.stringify(error.progress).includes('secret'));
      return true;
    });
    assert.equal(native.length, 1);
    const id = native[0]!.id;
    fail = undefined;
    const result = await service.reconcile(manifest, root);
    assert.equal(native.length, 2);
    assert.equal(native[0]!.id, id);
    assert.equal(result.outcomes[0]!.status, 'unchanged');
  });

  it('should require installed identity and report bounded partial results on gateway failure', async () => {
    loaded = false;
    await assert.rejects(service.reconcile(manifest, root), /automation-manifest-changed/u);
    assert.equal(mutations().length, 0);
    loaded = true;
    manifestDigest = 'fixture';
    fail = 'cron.add';
    await assert.rejects(
      service.reconcile(manifest, root),
      (error: unknown) => error instanceof Error && !error.message.includes('secret provider'),
    );
  });
  it('should keep execution and delivery failures separate without copying raw diagnostics', async () => {
    await service.reconcile(manifest, root);
    native[0]!.state = {
      lastRunStatus: 'error',
      lastRunAtMs: now,
      lastError: 'secret execution error',
      nextRunAtMs: now + 1000,
      lastDeliveryError: 'secret',
    };
    const findings = await service.inspect(manifest, root);
    assert.ok(findings.some(({ code }) => code === 'automation-execution-failed'));
    assert.ok(findings.some(({ code }) => code === 'automation-delivery-failed'));
    assert.ok(!JSON.stringify(findings).includes('secret'));
    const execution = findings.find(({ code }) => code === 'automation-execution-failed')!;
    assert.ok(execution.message.includes(new Date(now).toISOString()));
    assert.ok(execution.message.includes('failure reason: unavailable'));
    assert.ok(
      execution.remediation?.includes(
        `automations runs ${manifest.automations![0]!.id} --agent ${manifest.agent.id} --json`,
      ),
    );
    assert.ok(!execution.remediation?.includes('install'));
    assert.ok(findings.some(({ code }) => code === 'automation-healthy'));
    native[0]!.state.lastErrorReason = 'timeout';
    assert.ok(
      (await service.inspect(manifest, root))
        .find(({ code }) => code === 'automation-execution-failed')!
        .message.includes('failure reason: timeout'),
    );
    native[0]!.state.lastErrorReason = 'secret reason';
    assert.ok(!JSON.stringify(await service.inspect(manifest, root)).includes('secret'));
    native[0]!.state.lastRunAtMs = 'invalid';
    assert.ok(
      (await service.inspect(manifest, root))
        .find(({ code }) => code === 'automation-execution-failed')!
        .message.includes('last run: unavailable'),
    );
    native[0]!.state.lastRunStatus = 'ok';
    assert.ok(
      !(await service.inspect(manifest, root)).some(
        ({ code }) => code === 'automation-execution-failed',
      ),
    );
  });
  it('should reuse installed prompt jobs from a different gateway launcher context', async () => {
    manifest.automations = jobs([
      { id: 'prompt', schedule: 'every 1 hour', prompt: 'Review the repo.' },
    ]);
    await service.reconcile(manifest, root);
    const { store } = await service.scope(manifest, root);
    const installed = await store.read();
    const gateway = new AutomationService({
      ...service.dependencies,
      command: ['/opt/node/bin/node', '/opt/openclaw/dist/index.js'],
      environment: {},
    });
    calls = [];
    assert.ok(
      (await gateway.inspect(manifest, root)).some(({ code }) => code === 'automation-healthy'),
    );
    assert.equal((await gateway.run(manifest, root, 'prompt')).status, 'queued');
    const result = await gateway.reconcile(manifest, root);
    assert.ok(result.outcomes.every(({ status }) => status === 'unchanged'));
    assert.equal(mutations().length, 0);
    assert.deepEqual(await store.read(), installed);
    assert.equal(native.length, 1);
  });
  it('should project isolated owning-agent prompts and clear removed model overrides', async () => {
    manifest.automations = jobs([
      {
        id: 'prompt',
        schedule: 'every 1 hour',
        prompt: 'Review the repo.',
        overrides: { openclaw: { model: 'provider/model', effort: 'high' } },
      },
    ]);
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.agentId, 'tanaabot');
    assert.equal(native[0]!.sessionTarget, 'isolated');
    assert.deepEqual(native[0]!.payload.toolsAllow, ['*']);
    calls = [];
    await service.reconcile(manifest, root);
    assert.equal(mutations().length, 0);
    native[0]!.payload.toolsAllow = ['read'];
    assert.ok(
      (await service.inspect(manifest, root)).some(({ code }) => code === 'automation-drift'),
    );
    assert.deepEqual(native[0]!.payload.toolsAllow, ['read']);
    await service.reconcile(manifest, root);
    assert.deepEqual(native[0]!.payload.toolsAllow, ['*']);
    assert.ok(
      (await service.inspect(manifest, root)).some(({ code }) => code === 'automation-healthy'),
    );
    manifest.automations[0]!.overrides = {};
    await service.reconcile(manifest, root);
    assert.equal(native[0]!.payload.model, undefined);
    assert.equal(native[0]!.payload.thinking, undefined);
    assert.deepEqual(native[0]!.payload.toolsAllow, ['*']);
    assert.deepEqual(automationPatch(native[0]!, native[0]!), {});
    assert.equal(
      nativeAutomationHash(native[0]!),
      nativeAutomationHash({ ...native[0], state: { runningAtMs: now } }),
    );
  });
});
