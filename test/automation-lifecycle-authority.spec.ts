import assert from 'node:assert/strict';

import AutomationLifecycleAuthority, {
  verifyAutomationLifecycleRun,
  type AutomationLifecycleRun,
} from '../agent/automation-lifecycle-authority.ts';
import type { NotificationScheduler } from '../agent/automation-readiness.ts';
import {
  effectiveAutomation,
  nativeAutomationHash,
  projectAutomation,
} from '../agent/automation-projection.ts';
import AutomationStore, { type AutomationRecord } from '../agent/automation-store.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import registerAutomationLifecycleHooks from '../core/automation-lifecycle-hook.ts';

function fixture(options: { rejectStorage?: boolean; messages?: string[] } = {}) {
  const controller = new AbortController();
  const contexts = new Map<string, unknown>();
  const authority = new AutomationLifecycleAuthority(
    {
      setRunContext({ runId, value }) {
        if (options.rejectStorage) return false;
        contexts.set(runId, structuredClone(value));
        return true;
      },
      getRunContext({ runId }) {
        return contexts.get(runId);
      },
      clearRunContext({ runId }) {
        contexts.delete(runId);
      },
    },
    { debug: (message) => options.messages?.push(message) },
  );
  const context = {
    runId: 'run',
    jobId: 'native-job',
    trigger: 'cron',
    agentId: 'agent',
    workspaceDir: '/workspace',
    sessionKey: 'agent:agent:session',
    sessionId: 'session',
    abortSignal: controller.signal,
  };
  return {
    authority,
    contexts,
    context,
    cancel() {
      controller.abort();
    },
  };
}

describe('agent/automation-lifecycle-authority', () => {
  it('should diagnose missing initialization, rejected storage and lookup identity without exposing values', () => {
    const messages: string[] = [];
    const f = fixture({ messages });
    f.authority.begin({ ...f.context, sessionId: undefined });
    assert.equal(f.authority.resolve(f.context), undefined);
    f.authority.begin(f.context);
    assert.ok(f.authority.resolve(f.context));
    assert.equal(f.authority.resolve({ ...f.context, runId: 'different-run' }), undefined);
    f.authority.end(f.context.runId);
    assert.equal(f.authority.resolve(f.context), undefined);
    const rejected = fixture({ rejectStorage: true, messages });
    rejected.authority.begin(rejected.context);
    assert.equal(rejected.authority.resolve(rejected.context), undefined);
    for (const outcome of [
      'incomplete-or-not-cron',
      'stored',
      'storage-rejected',
      'found',
      'missing',
    ])
      assert.ok(messages.some((message) => message.includes(`outcome=${outcome}`)));
    const identities = messages.map((message) => JSON.parse(message.split('identity=')[1]!));
    assert.equal(identities[0].sessionId, null);
    assert.equal(identities[0].runId, identities[1].runId);
    assert.notEqual(identities[4].runId, identities[0].runId);
    for (const identity of identities)
      for (const value of Object.values(identity))
        assert.ok(value === null || /^[a-f0-9]{16}$/.test(String(value)));
    for (const value of ['/workspace', 'native-job', 'agent:agent:session', 'different-run'])
      assert.ok(!messages.join('\n').includes(value));
  });
  it('should bind scheduler identity through the shared host hook and clear it on run end', () => {
    const f = fixture();
    const hooks = new Map<
      string,
      {
        callback: (event: unknown, context: unknown) => unknown;
        options?: { requiresToolAuthority?: true };
      }
    >();
    registerAutomationLifecycleHooks(
      {
        on: ((name, callback, options) => {
          hooks.set(name, {
            callback: callback as (event: unknown, context: unknown) => unknown,
            options,
          });
        }) as OpenClawPluginApi['on'],
      },
      f.authority,
    );
    hooks.get('before_agent_reply')!.callback({}, f.context);
    const admitted = f.authority.resolve(f.context)!;
    assert.equal(admitted.run.jobId, 'native-job');
    hooks.get('agent_end')!.callback({}, f.context);
    assert.throws(() => admitted.assertCurrent());
    assert.equal(f.authority.resolve(f.context), undefined);
  });
  it('should verify declaration, installed ownership and native settings before admitting maintenance', async () => {
    const parsed = normalizeAutomations([
      { id: 'maintenance', schedule: 'every 1 hour', prompt: 'Inspect this agent.' },
    ]);
    assert.equal(parsed.status, 'valid');
    if (parsed.status !== 'valid') throw new Error('invalid fixture');
    const automations = parsed.automations as ResolvedAutomation[];
    const manifest: AgentManifest = { schemaVersion: 1, agent: { id: 'agent' }, automations };
    const context = {
      agentId: 'agent',
      workspaceDir: '/workspace',
      command: ['openclaw'],
      environment: {},
      timezone: 'UTC',
    };
    const store = new AutomationStore({
      root: '/unused',
      profile: '/profile',
      agentId: 'agent',
      workspaceDir: '/workspace',
    });
    const declared = automations[0]!;
    const record: AutomationRecord = {
      id: declared.id,
      marker: store.marker(declared.id),
      nativeId: 'native-job',
      hash: effectiveAutomation(declared, context).hash,
      triggerHash: 'a'.repeat(64),
      generation: 1,
      anchorMs: 0,
      removed: false,
    };
    const native = { ...projectAutomation(declared, record, context), id: 'native-job' } as Awaited<
      ReturnType<NotificationScheduler['list']>
    >[number] & { agentId: string; payload: Record<string, unknown> };
    record.nativeHash = nativeAutomationHash(native);
    store.read = async () => ({ version: 1, scope: store.scope, records: [record] });
    const service = {
      async scope() {
        return { context, store };
      },
    };
    const scheduler: NotificationScheduler = {
      async list() {
        return [native];
      },
    };
    const run: AutomationLifecycleRun = { ...fixture().context, jobId: 'native-job' };
    const verify = () => verifyAutomationLifecycleRun(service, scheduler, manifest, run);
    await verify();
    const methods: string[] = [];
    await verifyAutomationLifecycleRun(
      service,
      undefined,
      manifest,
      run,
      undefined,
      async (method) => {
        methods.push(method);
        return { jobs: [{ ...native, configRevision: '1', state: {} }], hasMore: false };
      },
    );
    assert.deepEqual(methods, ['cron.list']);
    await assert.rejects(
      verifyAutomationLifecycleRun(service, undefined, manifest, run, undefined, async () => ({
        jobs: [{ ...native, agentId: 'foreign', configRevision: '1', state: {} }],
        hasMore: false,
      })),
      /automation-lifecycle-drift/,
    );
    for (const change of [
      () => {
        native.agentId = 'foreign';
      },
      () => {
        native.payload = { ...native.payload, message: 'changed executable prompt' };
      },
      () => {
        record.removed = true;
      },
      () => {
        record.pending = { kind: 'update', nativeHash: 'b'.repeat(64) };
      },
      () => {
        declared.enabled = false;
      },
    ]) {
      const saved = {
        native: structuredClone(native),
        record: structuredClone(record),
        declared: structuredClone(declared),
      };
      change();
      await assert.rejects(verify());
      Object.keys(native).forEach((key) => delete (native as Record<string, unknown>)[key]);
      Object.assign(native, saved.native);
      Object.keys(record).forEach(
        (key) => delete (record as unknown as Record<string, unknown>)[key],
      );
      Object.assign(record, saved.record);
      Object.assign(declared, saved.declared);
    }
    await assert.rejects(verifyAutomationLifecycleRun(service, undefined, manifest, run));
  });
  it('should retain scheduled identity when the native tool context has no job id', () => {
    const f = fixture();
    f.authority.begin(f.context);
    const admitted = f.authority.resolve({
      runId: f.context.runId,
      agentId: f.context.agentId,
      sessionKey: f.context.sessionKey,
      sessionId: f.context.sessionId,
      abortSignal: f.context.abortSignal,
    });
    assert.equal(admitted?.run.jobId, 'native-job');
    f.cancel();
    assert.throws(() => admitted!.assertCurrent());
  });

  it('should not authorize cron-shaped interactive chats or missing host identities', () => {
    for (const changed of [
      { trigger: 'user' },
      { runId: undefined },
      { jobId: undefined },
      { sessionId: undefined },
      { agentId: undefined },
    ]) {
      const f = fixture();
      f.authority.begin({ ...f.context, ...changed });
      assert.equal(f.authority.resolve(f.context), undefined);
    }
  });

  it('should reject stale, replayed, cross-agent and cross-session invocation contexts', () => {
    const f = fixture();
    f.authority.begin(f.context);
    assert.throws(() => f.authority.resolve({ ...f.context, abortSignal: undefined }));
    for (const changed of [
      { agentId: 'foreign' },
      { sessionId: 'reset' },
      { sessionKey: 'foreign' },
    ])
      assert.throws(() => f.authority.resolve({ ...f.context, ...changed }));
    assert.equal(f.authority.resolve({ ...f.context, runId: 'interactive-followup' }), undefined);
    const admitted = f.authority.resolve(f.context)!;
    f.contexts.delete(f.context.runId);
    assert.throws(() => admitted.assertCurrent());
    f.authority.end(f.context.runId);
    assert.equal(f.authority.resolve(f.context), undefined);
  });
});
