import { retainOpenClawTurnInput } from '../agent/openclaw-turn-binding.ts';
import { nativeInputEvent } from '../agent/openclaw-session-input.ts';
import registerAgentSystemHooks from '../core/register-hooks.ts';
import assert from 'node:assert/strict';
import { ContextMaterialError } from '../agent/tasks/implementation/implementation-material.ts';

import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from 'openclaw/plugin-sdk/plugin-entry';

import type { DispatchCaller } from '../agent/openclaw-session-create.ts';
import {
  privateStateFileLockBusyErrorCode,
  privateStateFileLockLostErrorCode,
} from '../core/private-state-file-lock.ts';
import GitCommandError from '../tools/git/command-error.ts';
import createDispatchTool from '../tools/dispatch/tool.ts';
import { parseReplyRequest } from '../tools/dispatch/reply-schema.ts';
import { parseDirectImplementationRequest } from '../tools/dispatch/implementation-schema.ts';

interface HookContext {
  jobId?: string;
  requester?: { senderIsOwner?: boolean };
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

  function fixture(caller = coordinator) {
    const workspaceDir = `/workspaces/${caller.agentId}`;
    const hooks = new Map<string, Hook>();
    const factories: Array<OpenClawPluginToolFactory | OpenClawPluginToolFactory<2>> = [];
    let registrationOptions: Parameters<OpenClawPluginApi['registerTool']>[1];
    const session = {
      sessionId: caller.sessionId,
      archivedAt: undefined as number | undefined,
    };
    const manifest = {
      agent: { id: caller.agentId },
      github: { notifications: { schemaVersion: 3 as number | undefined } },
    };
    const runData = new Map<string, unknown>();
    const runContext = {
      setRunContext({
        runId,
        namespace,
        value,
      }: {
        runId: string;
        namespace: string;
        value?: unknown;
      }) {
        runData.set(`${runId}:${namespace}`, value);
        return true;
      },
      getRunContext({ runId, namespace }: { runId: string; namespace: string }) {
        return runData.get(`${runId}:${namespace}`);
      },
      clearRunContext() {
        runData.clear();
      },
    } as OpenClawPluginApi['runContext'];
    const reads = {
      async session() {
        return { ...session };
      },
      async manifest() {},
    };
    const api = {
      runContext,
      source: '/plugin/index.ts',
      runtimeSource: '/plugin/dist/index.js',
      registrationMode: 'full',
      on(name: string, handler: Hook) {
        hooks.set(name, handler);
      },
      registerTool(
        value: OpenClawPluginToolFactory | OpenClawPluginToolFactory<2>,
        options: Parameters<OpenClawPluginApi['registerTool']>[1],
      ) {
        factories.push(value);
        registrationOptions = options;
      },
      runtime: {
        agent: {
          session: {
            getSessionEntryAsync: async ({ sessionKey }: { sessionKey: string }) =>
              sessionKey === caller.sessionKey ? reads.session() : undefined,
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    const adapter = createDispatchTool({
      api,
      config: () => ({}),
      manifestService: {
        async loadForAgentId() {
          await reads.manifest();
          return { status: 'loaded', manifest, scope: { workspaceDir } };
        },
      },
    } as unknown as Parameters<typeof createDispatchTool>[0]);
    adapter.tool.registerTools(api, {} as Parameters<typeof adapter.tool.registerTools>[1]);
    const calls: DispatchCaller[] = [];
    adapter.service.run = async (_manifest, _workspace, who) => {
      calls.push(who);
      return { status: 'idle' };
    };
    assert.ok(factories.length);
    const build = (
      context: OpenClawPluginToolContext = {
        ...caller,
        workspaceDir,
        assertInvocationCurrent() {},
      },
      name = 'agent_system_dispatch',
    ) => {
      const tool = factories
        .map((factory) => {
          if (typeof factory === 'function') return factory(context);
          const assertInvocationCurrent = () => {
            if (!context.assertInvocationCurrent)
              throw new Error(
                'Plugin tool invocation authority is unavailable outside an admitted run or request',
              );
            context.assertInvocationCurrent();
          };
          const tool = factory.create({ ...context, assertInvocationCurrent });
          if (!tool || Array.isArray(tool)) return tool;
          return {
            ...tool,
            execute: (...args: Parameters<typeof tool.execute>) => {
              assertInvocationCurrent();
              return tool.execute(...args);
            },
          };
        })
        .find((value) => value && !Array.isArray(value) && value.name === name);
      assert.ok(tool && !Array.isArray(tool));
      return tool;
    };
    return {
      api,
      registrationOptions,
      runContext,
      hooks,
      hook: hooks.get('before_tool_call')!,
      build,
      calls,
      session,
      reads,
      adapter,
      manifest,
    };
  }

  it('should register a dynamic dispatch factory without a gateway adoption name', () => {
    const f = fixture();
    assert.equal(f.registrationOptions?.name, undefined);
    assert.deepEqual(f.registrationOptions?.names ?? [], []);
    assert.deepEqual(f.adapter.tool.toolNames, ['agent_system_dispatch', 'agent_system_context']);
    assert.equal(f.build().name, 'agent_system_dispatch');
    assert.equal(
      f.adapter.tool.isConfigured({
        ...f.manifest,
        schemaVersion: 1,
        github: { username: 'receiver' },
      }),
      true,
    );
    assert.equal(
      f.adapter.tool.isConfigured({ schemaVersion: 1, agent: { id: 'receiver' } }),
      true,
      'explicit native cleanup must not require GitHub configuration',
    );
  });

  it('should carry native cron identity only into its exact invocation', async () => {
    const f = fixture();
    await f.hooks.get('before_prompt_build')!(event, { ...coordinator, jobId: 'native-job' });
    await f.hook(event, coordinator);
    await f.build().execute(event.toolCallId, event.params);
    assert.equal(f.calls[0]?.jobId, 'native-job');
    await f.hook(
      { ...event, runId: 'other-run', toolCallId: 'other-call' },
      { ...coordinator, runId: 'other-run' },
    );
    await f.build().execute('other-call', event.params);
    assert.equal(f.calls[1]?.jobId, undefined);
  });

  it('should resolve context through a no-argument tool and reject selectors before execution', async () => {
    const f = fixture();
    const requests: unknown[] = [];
    f.adapter.service.runModel = async (_manifest, _workspace, _caller, input) => {
      requests.push(input);
      return { status: 'verified' } as Awaited<ReturnType<typeof f.adapter.service.runModel>>;
    };
    const context = f.build(undefined, 'agent_system_context');
    await f.hook({ ...event, toolName: 'agent_system_context', params: {} }, coordinator);
    await context.execute(event.toolCallId, {});
    assert.deepEqual(requests, [{ action: 'context' }]);
    for (const input of [
      { action: 'context' },
      { target: 'other' },
      { id: 'owner' },
      { threadId: 'foreign' },
    ])
      await assert.rejects(context.execute('invalid', input), /turn-context-request-invalid/);
    assert.equal(requests.length, 1);
  });

  it('should carry the native prompt input into tools and expire it with the host run', async () => {
    const f = fixture();
    retainOpenClawTurnInput(f.runContext, { ...coordinator, inputId: 'queued-input' });
    await f.hook(event, coordinator);
    await f.build().execute(event.toolCallId, event.params);
    assert.equal(f.calls[0]?.inputId, 'queued-input');
    const rejected = await f.hook(event, { ...coordinator, sessionId: 'replacement' });
    assert.ok(rejected);
    f.runContext.clearRunContext({ runId: coordinator.runId });
    await f.hook(event, coordinator);
    await f.build().execute(event.toolCallId, event.params);
    assert.equal(f.calls[1]?.inputId, undefined);
  });

  it('should resolve a hosted prompt key through binding and dispatch to its history event', async () => {
    const f = fixture();
    const inputId = 'submission:assessment:user';
    let verified: Awaited<ReturnType<typeof nativeInputEvent>> | undefined;
    registerAgentSystemHooks(
      f.api,
      {
        async loadForRuntimeContext() {
          return {
            status: 'loaded',
            manifest: { schemaVersion: 1, agent: { id: coordinator.agentId } },
            scope: { agentId: coordinator.agentId, workspaceDir: '/workspaces/receiver' },
            path: '/workspaces/receiver/agent.yaml',
            digest: 'fixture',
            diagnostics: [],
            validationChecks: [],
          };
        },
      },
      { guidance: () => [] },
      async (_manifest, _workspace, binding) => {
        retainOpenClawTurnInput(f.runContext, binding);
        return undefined;
      },
    );
    const promptHook = f.hooks.get('before_prompt_build')!;
    await promptHook(
      { prompt: 'untrusted contents', messages: [], currentUserMessageId: inputId } as never,
      coordinator,
    );
    f.adapter.service.run = async (_manifest, _workspace, who) => {
      assert.equal(who.inputId, inputId);
      verified = await nativeInputEvent({
        ...coordinator,
        inputId: who.inputId,
        retained: [],
        request: async (_method, params) => {
          if (!params.messageId) {
            assert.deepEqual(params.inputRunIds, ['submission:assessment']);
            return {
              sessionId: coordinator.sessionId,
              messages: [],
              inputReceipts: [
                {
                  runId: 'submission:assessment',
                  state: 'consumed',
                  consumedByEventId: 'event-uuid',
                },
              ],
            };
          }
          assert.equal(params.sessionId, coordinator.sessionId);
          return {
            sessionId: coordinator.sessionId,
            messages:
              params.messageId === 'event-uuid'
                ? [
                    {
                      role: 'user',
                      content: 'original assignment',
                      idempotencyKey: inputId,
                      __openclaw: { id: 'event-uuid', idempotencyKey: inputId },
                    },
                  ]
                : [],
          };
        },
      });
      return { status: 'idle' };
    };
    await f.hook(event, coordinator);
    await f.build().execute(event.toolCallId, event.params);
    assert.equal(verified?.inputEventId, 'event-uuid');
    assert.equal(verified?.runId, coordinator.runId);
  });

  it('should explain malformed authored arguments at both public entry points', async () => {
    const f = fixture();
    for (const [params, expected] of [
      [
        { action: 'reply', operation: 'compose', outcome: { private: 'private-value' } },
        /request\.outcome must be string/,
      ],
      [
        { action: 'implementation', operation: 'result', summary: 'private-value' },
        /outcome, summary and fullResult inside result/,
      ],
      [{ action: 'reply', operation: 'compose', digest: 'private-value' }, /unsupported fields/],
      [{ action: 'context', operation: 'context' }, /agent_system_context with \{\}/],
      [{ action: 'contextRequest' }, /agent_system_context with \{\}/],
    ] as const) {
      for (const run of [
        () => f.build().execute('invalid', params),
        () =>
          f.adapter.service.runModel(
            f.manifest as never,
            '/unused',
            { ...coordinator, toolCallId: 'invalid' },
            params,
          ),
      ])
        await assert.rejects(run, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, expected);
          assert.doesNotMatch(error.message, /private-value/);
          return true;
        });
    }
    assert.equal(f.calls.length, 0);
  });

  it('should retain safe request recovery through the native error response', async () => {
    const f = fixture();
    for (const parse of [
      () => parseReplyRequest({ action: 'reply', operation: 'context' }),
      () => parseDirectImplementationRequest({ action: 'implementation', operation: 'result' }),
    ]) {
      f.adapter.service.runModel = async () => {
        parse();
        throw new Error('must reject');
      };
      await f.hook(event, coordinator);
      const result = await f.build().execute(event.toolCallId, event.params);
      const value = JSON.parse((result.content[0] as { text: string }).text);
      assert.match(value.code, /^(reply|implementation)-request-invalid$/);
      assert.equal(typeof value.recovery.instruction, 'string');
      assert.match(value.recovery.instruction, /status-update|outcome, summary and fullResult/);
    }
  });

  it('should isolate simultaneous caller captures across agents with the same call id', async () => {
    const observer = {
      agentId: 'observer',
      sessionKey: 'agent:observer:automation:intake',
      sessionId: 'observer-session',
      runId: 'observer-run',
    };
    const first = fixture();
    const second = fixture(observer);
    await first.hook(event, coordinator);
    await assert.rejects(
      second.build().execute(event.toolCallId, event.params),
      /dispatch-native-invocation-missing/,
    );
    await second.hook(event, observer);
    await Promise.all([
      first.build().execute(event.toolCallId, event.params),
      second.build().execute(event.toolCallId, event.params),
    ]);
    assert.deepEqual(first.calls, [{ ...coordinator, toolCallId: event.toolCallId }]);
    assert.deepEqual(second.calls, [{ ...observer, toolCallId: event.toolCallId }]);
    for (const f of [first, second])
      await assert.rejects(
        f.build().execute(event.toolCallId, event.params),
        /dispatch-native-invocation-missing/,
      );
  });

  it('should return bounded dispatch blockers without exposing raw transport errors', async () => {
    for (const [error, code] of [
      [new Error('dispatch-intake-activation-required'), 'dispatch-intake-activation-required'],
      [new Error('private fixture token details'), 'dispatch-operation-failed'],
      [
        new ContextMaterialError(
          'assessment-material-controls-too-large',
          'private fixture details',
        ),
        'assessment-material-controls-too-large',
      ],
      [
        new ContextMaterialError('implementation-material-stale', 'private fixture details'),
        'implementation-material-stale',
      ],
      ...[privateStateFileLockBusyErrorCode, privateStateFileLockLostErrorCode].map((code) => [
        Object.assign(new Error('private fixture lock details'), { code }),
        code,
      ]),
      [
        Object.assign(new Error('private fixture token details'), {
          code: 'private-fixture-token',
        }),
        'dispatch-operation-failed',
      ],
    ] as const) {
      const f = fixture();
      f.adapter.service.run = async () => {
        throw error;
      };
      const call = { ...event, params: { action: 'next' } };
      await f.hook(call, coordinator);
      const result = await f.build().execute(call.toolCallId, call.params);
      const { notice, presentationInstructions, recovery, ...details } = result.details as Record<
        string,
        unknown
      >;
      assert.ok(notice);
      assert.equal(typeof presentationInstructions, 'string');
      if (code === 'implementation-material-stale')
        assert.match(
          String((recovery as { instruction: string }).instruction),
          /returned page request/,
        );
      else assert.equal(recovery, undefined);
      assert.deepEqual(details, {
        status: 'waiting',
        code,
        runtime: 'openclaw',
        operation: 'dispatch:next',
        failureDiagnostic: { step: 'dispatch', category: 'error' },
      });
      assert.ok(!JSON.stringify(result).includes('private fixture'));
    }
  });

  it('should return a redacted git provider failure card from the native dispatch boundary', async () => {
    const f = fixture();
    f.adapter.service.run = async () => {
      throw new GitCommandError('fetch', {
        exitCode: 128,
        stderr: 'remote: Permission to owner/repo denied. token=ghp_private',
      });
    };
    const call = { ...event, params: { action: 'next' } };
    await f.hook(call, coordinator);
    const result = await f.build().execute(call.toolCallId, call.params);
    const details = result.details as { notice: { message: string; severity: string } };
    assert.equal(details.notice.severity, 'error');
    assert.match(details.notice.message, /❌|Git could not/);
    assert.match(details.notice.message, /Permission to owner/);
    assert.doesNotMatch(JSON.stringify(result), /ghp_private/);
  });

  it('should supply ordinary workflow failure cards without provider diagnostics', async () => {
    for (const [code, severity, emoji] of [
      ['assessment-render-request-invalid', 'error', '❌'],
      ['reply-request-invalid', 'error', '❌'],
      ['dispatch-project-registration-unavailable', 'warning', '⚠️'],
    ]) {
      const f = fixture();
      f.adapter.service.run = async () => {
        throw new Error(code);
      };
      await f.hook(event, coordinator);
      const result = await f.build().execute(event.toolCallId, event.params);
      const details = result.details as {
        code: string;
        notice: { message: string; severity: string };
      };
      assert.equal(details.code, code);
      assert.equal(details.notice.severity, severity);
      assert.ok(details.notice.message.startsWith('> ## ' + emoji));
      assert.ok(details.notice.message.includes('`' + code + '`'));
      assert.ok(details.notice.message.split('\n').every((line) => line.startsWith('>')));
    }
  });

  it('should allow the read-only predicate without a conversation session id', async () => {
    const { hook, build, adapter } = fixture();
    let checked = false;
    adapter.service.check = async () => {
      checked = true;
      return { status: 'ready', changed: false, more: false, outcome: 'idle' };
    };
    assert.equal(await hook({ ...event, params: { action: 'check' } }, trigger), undefined);
    await build(trigger).execute('condition', { action: 'check' });
    assert.equal(checked, true);
  });

  it('should retain caller verification for every other dispatch action', async () => {
    const { hook } = fixture();
    for (const action of ['inspect', 'next', 'prepare', 'reconcile', 'retry']) {
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

  it('should distinguish separate adapter captures from a changed execution id', async () => {
    const source = fixture();
    const destination = fixture();
    await source.hook(event, coordinator);
    await assert.rejects(
      destination.build().execute(event.toolCallId, event.params),
      /dispatch-native-invocation-missing/,
    );
    await assert.rejects(
      source.build().execute('different-call', event.params),
      /dispatch-native-invocation-missing/,
    );
    await source.build().execute(event.toolCallId, event.params);
    assert.equal(source.calls.length, 1);
    assert.deepEqual(destination.calls, []);
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

  it('should reject execution after a reset or archive during the hook metadata read', async () => {
    for (const change of ['reset', 'archive'] as const) {
      const f = fixture();
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      f.reads.session = async () => {
        const stale = { ...f.session };
        started.resolve();
        await resume.promise;
        return stale;
      };
      const pending = f.hook(event, coordinator);
      await started.promise;
      if (change === 'reset') f.session.sessionId = 'replacement';
      else f.session.archivedAt = 1;
      resume.resolve();
      assert.equal(await pending, undefined);
      await assert.rejects(
        f.build().execute(event.toolCallId, event.params),
        /dispatch-native-session-diverged/,
      );
      assert.deepEqual(f.calls, []);
    }
  });

  it('should dispatch without optional memory audience authority', async () => {
    const f = fixture();
    await f.hook(event, coordinator);
    await f.build().execute(event.toolCallId, event.params);
    assert.equal(f.calls.length, 1);
  });

  it('should reject host authority revoked during an awaited session read', async () => {
    const f = fixture();
    await f.hook(event, coordinator);
    let revoked = false;
    f.reads.session = async () => {
      const stale = { ...f.session };
      await Promise.resolve();
      revoked = true;
      return stale;
    };
    await assert.rejects(
      f
        .build({
          ...coordinator,
          assertInvocationCurrent() {
            if (revoked) throw new Error('invocation expired');
          },
        })
        .execute(event.toolCallId, event.params),
      /invocation expired/,
    );
    assert.deepEqual(f.calls, []);
  });

  it('should recheck host and session authority after a manifest refresh', async () => {
    for (const change of ['reset', 'archive', 'revoke', 'abort', 'workspace'] as const) {
      const f = fixture();
      await f.hook(event, coordinator);
      let revoked = false;
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let rejected: unknown;
      f.adapter.service.runModel = async (...args) => {
        f.reads.manifest = async () => {
          started.resolve();
          await resume.promise;
        };
        try {
          await args[5]?.assertCurrent?.();
        } catch (error) {
          rejected = error;
          throw error;
        }
        f.calls.push(args[2]);
        return { status: 'idle' };
      };
      const pending = f
        .build({
          ...coordinator,
          assertInvocationCurrent() {
            if (revoked) throw new Error('revoked');
          },
        })
        .execute(event.toolCallId, event.params, controller.signal);
      await started.promise;
      if (change === 'reset') f.session.sessionId = 'replacement';
      if (change === 'archive') f.session.archivedAt = 1;
      if (change === 'revoke') revoked = true;
      if (change === 'abort') controller.abort();
      if (change === 'workspace') f.manifest.agent.id = 'other';
      resume.resolve();
      await pending;
      assert.match(String(rejected), /diverged|revoked|abort|binding|manifest/iu);
      assert.deepEqual(f.calls, []);
    }
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

  it('should leave unrelated native session tools untouched and install no spawn lifecycle hooks', async () => {
    const f = fixture();
    for (const toolName of ['sessions_spawn', 'sessions_send', 'sessions_list']) {
      assert.equal(await f.hook({ toolName, params: {} }, coordinator), undefined);
      assert.equal(
        await f.hooks.get('after_tool_call')!({ toolName, params: {} }, coordinator),
        undefined,
      );
    }
    assert.equal(f.hooks.has('agent_end'), false);
  });
  it('should require native factory owner evidence for retry without trusting hook ownership alone', async () => {
    const f = fixture();
    const values: boolean[] = [];
    f.adapter.service.runModel = async (_manifest, _workspace, _who, _input, owner) => {
      values.push(owner === true);
      return { status: 'idle' };
    };
    const request = { ...event, params: { action: 'retry' } };
    for (const senderIsOwner of [true, false, undefined]) {
      await f.hook(request, { ...coordinator, requester: { senderIsOwner: true } });
      await f
        .build({ ...coordinator, workspaceDir: '/workspaces/receiver', senderIsOwner })
        .execute(request.toolCallId, request.params);
    }
    assert.deepEqual(values, [true, false, false]);
  });

  for (const action of ['handoff', 'retire'] as const)
    it(`should require both native requester and factory owner evidence for ${action}`, async () => {
      const f = fixture();
      const values: boolean[] = [];
      f.adapter.service.runModel = async (_manifest, _workspace, _who, _input, owner) => {
        values.push(owner === true);
        return { status: 'idle' };
      };
      const request = {
        ...event,
        params: { action },
      };
      for (const [hookOwner, factoryOwner] of [
        [true, true],
        [true, false],
        [false, true],
        [undefined, true],
      ]) {
        await f.hook(request, { ...coordinator, requester: { senderIsOwner: hookOwner } });
        await f
          .build({
            ...coordinator,
            workspaceDir: '/workspaces/receiver',
            senderIsOwner: factoryOwner,
          })
          .execute(request.toolCallId, request.params);
      }
      assert.deepEqual(values, [true, false, false, false]);
    });
});
