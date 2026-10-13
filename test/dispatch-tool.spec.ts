import assert from 'node:assert/strict';

import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from 'openclaw/plugin-sdk/plugin-entry';

import type { DispatchCaller } from '../agent/openclaw-dispatch-handoff.ts';
import createDispatchTool from '../tools/dispatch/tool.ts';

interface HookContext {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
}
interface HookEvent {
  toolName: string;
  toolCallId?: string;
  runId?: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
}
type Hook = (
  event: HookEvent,
  context: HookContext,
) => Promise<{ block: boolean; blockReason: string } | undefined>;

describe('tools/dispatch/tool', () => {
  const coordinator = {
    agentId: 'receiver',
    sessionKey: 'agent:receiver:automation:intake',
    sessionId: 'coordinator-id',
    runId: 'coordinator-run',
  };
  const trigger = {
    agentId: 'receiver',
    sessionKey: 'agent:receiver:cron:assignment:trigger',
    runId: 'trigger-run',
  };
  const event = {
    toolName: 'agent_system_dispatch',
    toolCallId: 'next-call',
    params: { action: 'next' },
  };

  function fixture() {
    const hooks = new Map<string, Hook>();
    const diagnostics: Array<Record<string, unknown>> = [];
    let factory: OpenClawPluginToolFactory | undefined;
    const session = {
      sessionId: coordinator.sessionId,
      archivedAt: undefined as number | undefined,
    };
    const manifest = {
      agent: { id: coordinator.agentId },
      github: { notifications: { schemaVersion: 2 } },
    };
    const api = {
      source: '/plugin/index.ts',
      runtimeSource: '/plugin/dist/index.js',
      registrationMode: 'full',
      on(name: string, handler: Hook) {
        hooks.set(name, handler);
      },
      registerTool(value: OpenClawPluginToolFactory) {
        factory = value;
      },
      runtime: {
        agent: {
          session: {
            getSessionEntry: ({ sessionKey }: { sessionKey: string }) =>
              sessionKey === coordinator.sessionKey ? session : undefined,
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    const adapter = createDispatchTool({
      api,
      runtimeUrl: 'file:///plugin/dist/index.js',
      diagnostics: {
        info(message: string) {
          diagnostics.push(JSON.parse(message.slice('dispatch-invocation '.length)));
        },
      },
      manifestService: {
        async loadForAgentId() {
          return { status: 'loaded', manifest, scope: { workspaceDir: '/workspace' } };
        },
      },
    } as unknown as Parameters<typeof createDispatchTool>[0]);
    adapter.tool.registerTools(api, {} as Parameters<typeof adapter.tool.registerTools>[1]);
    const calls: DispatchCaller[] = [];
    adapter.service.run = async (_manifest, _workspace, who) => {
      calls.push(who);
      return { status: 'idle' };
    };
    assert.ok(factory);
    const build = (context: OpenClawPluginToolContext = coordinator) => {
      const tool = factory!(context);
      assert.ok(tool && !Array.isArray(tool));
      return tool;
    };
    return {
      diagnostics,
      hooks,
      hook: hooks.get('before_tool_call')!,
      build,
      calls,
      session,
      adapter,
      manifest,
    };
  }

  it('should allow the read-only predicate without a conversation session id', async () => {
    const { hook } = fixture();
    assert.equal(await hook({ ...event, params: { action: 'check' } }, trigger), undefined);
  });

  it('should retain caller verification for every other dispatch action', async () => {
    const { hook } = fixture();
    for (const action of [
      'inspect',
      'next',
      'prepare',
      'reconcile',
      'retry',
      'context',
      'result',
    ]) {
      const blocked = await hook({ ...event, params: { action } }, trigger);
      assert.equal(blocked?.block, true);
      assert.match(blocked!.blockReason, /dispatch-native-hook-rejected.*sessionId=false/);
      assert.ok(!blocked!.blockReason.includes(trigger.sessionKey));
      assert.ok(!blocked!.blockReason.includes(trigger.runId));
    }
  });

  it('should not exempt a check containing caller-selected identity fields', async () => {
    const { hook, build } = fixture();
    const forged = { action: 'check', agentId: 'other' };
    assert.equal((await hook({ ...event, params: forged }, trigger))?.block, true);
    await assert.rejects(build().execute('forged', forged), /dispatch-request-invalid/);
  });

  it('should carry host invocation identity from the hook to execution exactly once', async () => {
    const { hook, build, calls } = fixture();
    assert.equal(await hook(event, coordinator), undefined);
    assert.deepEqual((await build().execute(event.toolCallId, event.params)).details, {
      status: 'idle',
    });
    assert.deepEqual(calls, [{ ...coordinator, toolCallId: event.toolCallId }]);
    await assert.rejects(
      build().execute(event.toolCallId, event.params),
      /dispatch-native-invocation-missing/,
    );
  });

  it('should correlate capture and execution without logging raw caller identity', async () => {
    const { hook, build, diagnostics } = fixture();
    await hook(event, coordinator);
    await build().execute(event.toolCallId, event.params);
    const capture = diagnostics.find((entry) => entry.stage === 'captured')!;
    const execution = diagnostics.find((entry) => entry.stage === 'execute')!;
    const registration = diagnostics.find((entry) => entry.stage === 'registered')!;
    assert.equal(registration.instance, capture.instance);
    assert.equal(registration.source, '/plugin/index.ts');
    assert.equal(registration.runtimeSource, '/plugin/dist/index.js');
    assert.equal(registration.runtimeUrl, 'file:///plugin/dist/index.js');
    assert.equal(registration.registrationMode, 'full');
    assert.ok(Array.isArray(registration.constructionStack));
    assert.ok(registration.constructionStack.length > 0);
    assert.equal(execution.constructionStack, undefined);
    assert.equal(capture.instance, execution.instance);
    assert.equal(capture.eventCall, execution.executeCall);
    assert.equal(execution.capturePresent, true);
    assert.equal(execution.capturedRun, capture.contextRun);
    assert.ok(Number(capture.sequence) < Number(execution.sequence));
    for (const value of [...Object.values(coordinator), event.toolCallId])
      assert.ok(!JSON.stringify(diagnostics).includes(value));
  });

  it('should distinguish separate adapter captures from a changed execution id', async () => {
    const source = fixture();
    const destination = fixture();
    await source.hook(event, coordinator);
    await assert.rejects(
      destination.build().execute(event.toolCallId, event.params),
      /dispatch-native-invocation-missing/,
    );
    const capture = source.diagnostics.find((entry) => entry.stage === 'captured')!;
    const execution = destination.diagnostics.find((entry) => entry.stage === 'execute')!;
    assert.notEqual(capture.instance, execution.instance);
    assert.equal(capture.eventCall, execution.executeCall);
    assert.equal(execution.capturePresent, false);
    await assert.rejects(
      source.build().execute('different-call', event.params),
      /dispatch-native-invocation-missing/,
    );
    const mismatch = source.diagnostics.find((entry) => entry.stage === 'execute')!;
    assert.equal(capture.instance, mismatch.instance);
    assert.notEqual(capture.eventCall, mismatch.executeCall);
    assert.equal(mismatch.pendingCaptures, 1);
    assert.deepEqual(destination.calls, []);
  });

  it('should identify cleanup before execution without restoring consumed authority', async () => {
    const { hook, hooks, build, diagnostics, calls } = fixture();
    await hook(event, coordinator);
    await hooks.get('after_tool_call')!(event, coordinator);
    await assert.rejects(
      build().execute(event.toolCallId, event.params),
      /dispatch-native-invocation-missing/,
    );
    const cleanup = diagnostics.find((entry) => entry.stage === 'cleanup')!;
    const execution = diagnostics.find((entry) => entry.stage === 'execute')!;
    assert.equal(cleanup.capturePresent, true);
    assert.equal(execution.capturePresent, false);
    assert.equal(cleanup.eventCall, execution.executeCall);
    assert.ok(Number(cleanup.sequence) < Number(execution.sequence));
    assert.deepEqual(calls, []);
  });

  it('should accept the host event run id and verify an omitted factory session id against the live entry', async () => {
    const { hook, build, calls } = fixture();
    assert.equal(
      await hook(
        { ...event, runId: coordinator.runId },
        { ...coordinator, sessionId: undefined, runId: undefined },
      ),
      undefined,
    );
    await build({ ...coordinator, sessionId: undefined }).execute(event.toolCallId, event.params);
    assert.equal(calls[0]?.sessionId, coordinator.sessionId);
    assert.equal(calls[0]?.runId, coordinator.runId);
  });

  it('should distinguish a missing hook context or capture from a mismatched factory', async () => {
    const { hook, build, calls } = fixture();
    assert.match((await hook(event, {}))!.blockReason, /dispatch-native-hook-context-unavailable/);
    await assert.rejects(
      build().execute('uncaptured', event.params),
      /dispatch-native-invocation-missing/,
    );
    for (const context of [
      { ...coordinator, sessionKey: 'agent:receiver:other' },
      { ...coordinator, sessionId: 'replacement' },
    ]) {
      await hook(event, coordinator);
      await assert.rejects(
        build(context).execute(event.toolCallId, event.params),
        /dispatch-native-factory-mismatch/,
      );
    }
    assert.deepEqual(calls, []);
  });

  it('should reject conflicting host run and tool ids without capturing a call', async () => {
    const { hook, build } = fixture();
    for (const context of [
      { ...coordinator, runId: 'different-run' },
      { ...coordinator, toolCallId: 'different-call' },
    ]) {
      assert.match(
        (await hook({ ...event, runId: coordinator.runId }, context))!.blockReason,
        /dispatch-native-caller-conflict/,
      );
      await assert.rejects(
        build().execute(event.toolCallId, event.params),
        /dispatch-native-invocation-missing/,
      );
    }
  });

  it('should reject a reset, archived session or expired host authority after capture', async () => {
    const { hook, build, session, calls } = fixture();
    await hook(event, coordinator);
    session.sessionId = 'replacement';
    await assert.rejects(
      build({ ...coordinator, sessionId: undefined }).execute(event.toolCallId, event.params),
      /dispatch-native-session-diverged/,
    );
    session.sessionId = coordinator.sessionId;
    await hook(event, coordinator);
    session.archivedAt = 1;
    await assert.rejects(
      build().execute(event.toolCallId, event.params),
      /dispatch-native-session-diverged/,
    );
    session.archivedAt = undefined;
    await hook(event, coordinator);
    await assert.rejects(
      build({
        ...coordinator,
        assertInvocationCurrent() {
          throw new Error('expired');
        },
      }).execute(event.toolCallId, event.params),
      /expired/,
    );
    assert.deepEqual(calls, []);
  });

  it('should remove an unused capture after a terminal tool hook', async () => {
    const { hook, hooks, build } = fixture();
    await hook(event, coordinator);
    await hooks.get('after_tool_call')!(event, coordinator);
    await assert.rejects(
      build().execute(event.toolCallId, event.params),
      /dispatch-native-invocation-missing/,
    );
  });

  it('should correlate creation and continuation receipts with the host event run identity', async () => {
    const { adapter, hook, hooks } = fixture();
    const record = {
      id: 'retained-request',
      sourceThreadId: coordinator.sessionKey,
      threadId: 'agent:receiver:issue:1',
      request: { task: 'Setup only' },
      creationCall: { toolCallId: 'create-call' },
      continuation: { toolCallId: 'continue-call' },
    };
    adapter.service.scope = async () =>
      ({
        journal: { read: async () => ({ records: [record] }) },
      }) as unknown as Awaited<ReturnType<typeof adapter.service.scope>>;
    const observations: unknown[][] = [];
    adapter.service.handoff = async () =>
      ({
        claimCreation: async (...args: unknown[]) => {
          observations.push(['claimCreation', ...args]);
        },
        observeCreation: async (...args: unknown[]) => {
          observations.push(['observeCreation', ...args]);
        },
        claimContinuation: async (...args: unknown[]) => {
          observations.push(['claimContinuation', ...args]);
        },
        observeContinuation: async (...args: unknown[]) => {
          observations.push(['observeContinuation', ...args]);
        },
      }) as unknown as Awaited<ReturnType<typeof adapter.service.handoff>>;
    const context = { ...coordinator, sessionId: undefined, runId: undefined };
    const source = {
      sessionKey: coordinator.sessionKey,
      sessionId: coordinator.sessionId,
      runId: coordinator.runId,
    };
    const creation = {
      toolName: 'sessions_spawn',
      toolCallId: 'create-call',
      runId: coordinator.runId,
      params: record.request,
    };
    assert.equal(await hook(creation, context), undefined);
    await hooks.get('after_tool_call')!(
      {
        ...creation,
        result: {
          details: {
            status: 'accepted',
            childSessionKey: record.threadId,
            runId: 'setup-run',
          },
        },
      },
      context,
    );
    const continuation = {
      toolName: 'sessions_send',
      toolCallId: 'continue-call',
      runId: coordinator.runId,
      params: { sessionKey: record.threadId },
    };
    assert.equal(await hook(continuation, context), undefined);
    await hooks.get('after_tool_call')!(
      {
        ...continuation,
        result: {
          details: {
            status: 'accepted',
            runId: 'assessment-run',
          },
        },
      },
      context,
    );
    assert.deepEqual(observations, [
      ['claimCreation', record.id, { ...source, toolCallId: 'create-call' }, record.request],
      [
        'observeCreation',
        record.id,
        { ...source, toolCallId: 'create-call' },
        { sessionKey: record.threadId, runId: 'setup-run' },
      ],
      [
        'claimContinuation',
        record.id,
        { ...source, toolCallId: 'continue-call' },
        continuation.params,
      ],
      [
        'observeContinuation',
        record.id,
        { ...source, toolCallId: 'continue-call' },
        'assessment-run',
      ],
    ]);
    await hooks.get('after_tool_call')!(
      {
        ...creation,
        toolCallId: 'unclaimed',
        result: {
          status: 'accepted',
          childSessionKey: record.threadId,
          runId: 'forged-run',
        },
      },
      context,
    );
    assert.equal(observations.length, 4);
  });
});
