import assert from 'node:assert/strict';

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

interface HookContext {
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
    let factory: OpenClawPluginToolFactory | undefined;
    let registrationOptions: Parameters<OpenClawPluginApi['registerTool']>[1];
    const session = {
      sessionId: caller.sessionId,
      archivedAt: undefined as number | undefined,
    };
    const manifest = {
      agent: { id: caller.agentId },
      github: { notifications: { schemaVersion: 3 as number | undefined } },
    };
    const reads = {
      async session() {
        return { ...session };
      },
      async manifest() {},
    };
    const api = {
      source: '/plugin/index.ts',
      runtimeSource: '/plugin/dist/index.js',
      registrationMode: 'full',
      on(name: string, handler: Hook) {
        hooks.set(name, handler);
      },
      registerTool(
        value: OpenClawPluginToolFactory,
        options: Parameters<OpenClawPluginApi['registerTool']>[1],
      ) {
        factory = value;
        registrationOptions = options;
      },
      runtime: {
        agent: {
          session: {
            getSessionEntryAsync: async ({ sessionKey }: { sessionKey: string }) =>
              sessionKey === caller.sessionKey ? reads.session() : undefined,
            getSessionEntry: ({ sessionKey }: { sessionKey: string }) =>
              sessionKey === caller.sessionKey ? session : undefined,
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
    assert.ok(factory);
    const build = (context: OpenClawPluginToolContext = { ...caller, workspaceDir }) => {
      const tool = factory!(context);
      assert.ok(tool && !Array.isArray(tool));
      return tool;
    };
    return {
      registrationOptions,
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
    assert.deepEqual(f.adapter.tool.toolNames, ['agent_system_dispatch']);
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
      assert.deepEqual(result.details, {
        status: 'waiting',
        code,
        runtime: 'openclaw',
        operation: 'dispatch:next',
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

  it('should allow the read-only predicate without a conversation session id', async () => {
    const { hook } = fixture();
    assert.equal(await hook({ ...event, params: { action: 'check' } }, trigger), undefined);
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

  it('should reject a reset or archive while the descriptive read is suspended', async () => {
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
      assert.match((await pending)!.blockReason, /dispatch-native-session-diverged/);
      await assert.rejects(
        f.build().execute(event.toolCallId, event.params),
        /dispatch-native-invocation-missing/,
      );
      assert.deepEqual(f.calls, []);
    }
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
      f.adapter.service.run = async (...args) => {
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
  for (const action of ['handoff', 'retire'] as const)
    it(`should require both native requester and factory owner evidence for ${action}`, async () => {
      const f = fixture();
      const values: boolean[] = [];
      f.adapter.service.run = async (_manifest, _workspace, _who, _input, owner) => {
        values.push(owner === true);
        return { status: 'idle' };
      };
      const request = {
        ...event,
        params: { action, id: 'a'.repeat(64) },
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
