import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { AutomationGateway, NativeAutomation } from '../agent/automation-gateway.ts';
import { automationPatch, nativeAutomationHash } from '../agent/automation-projection.ts';
import AutomationService from '../agent/automation-service.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
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
      if (method === 'cron.status') return { enabled: true };
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
        patch.payload = { ...job.payload, ...(patch.payload as object) };
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
      for (const key of ['trigger', 'pacing', 'sessionKey']) if (job[key] === null) delete job[key];
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
      request,
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
                digest: 'fixture',
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
          autoLabel: params.autoLabel,
          displayName: params.autoLabel,
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
      nextRunAtMs: now + 1000,
      lastDeliveryError: 'secret',
    };
    const findings = await service.inspect(manifest, root);
    assert.ok(findings.some(({ code }) => code === 'automation-execution-failed'));
    assert.ok(findings.some(({ code }) => code === 'automation-delivery-failed'));
    assert.ok(!JSON.stringify(findings).includes('secret'));
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
    await service.reconcile(manifest, root);
    assert.deepEqual(native[0]!.payload.toolsAllow, ['*']);
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
