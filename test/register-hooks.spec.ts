import assert from 'node:assert/strict';

import registerAgentSystemHooks from '../lib/register-hooks.ts';

describe('lib/register-hooks', () => {
  it('should load environments at passive agent-aware runtime boundaries', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const calls: Array<{ agentId?: string; trigger: string }> = [];
    registerAgentSystemHooks(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
      } as never,
      {
        async loadForRuntimeContext(context, trigger) {
          calls.push({ agentId: context.agentId, trigger });
          return { status: 'unresolved', diagnostics: [] };
        },
      },
    );

    await handlers.get('session_start')?.({}, { agentId: 'tanaabot', sessionId: 'one' });
    await handlers.get('before_tool_call')?.({}, { agentId: 'tanaabot', toolName: 'exec' });

    assert.deepEqual(calls, [
      { agentId: 'tanaabot', trigger: 'session_start' },
      { agentId: 'tanaabot', trigger: 'before_tool_call' },
    ]);
  });

  it('should block exec when an active manifest is invalid but allow unmanaged workspaces', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let result: 'invalid' | 'unmanaged' = 'invalid';
    registerAgentSystemHooks(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
      } as never,
      {
        async loadForRuntimeContext() {
          return result === 'invalid'
            ? {
                status: 'invalid',
                scope: { agentId: 'data', workspaceDir: '/workspace' },
                diagnostics: [{ code: 'manifest-schema', message: 'invalid', severity: 'error' }],
              }
            : {
                status: 'unmanaged',
                scope: { agentId: 'data', workspaceDir: '/workspace' },
                diagnostics: [],
              };
        },
      },
    );

    const invalid = await handlers.get('before_tool_call')?.(
      { toolName: 'exec' },
      { agentId: 'data' },
    );
    result = 'unmanaged';
    const unmanaged = await handlers.get('before_tool_call')?.(
      { toolName: 'exec' },
      { agentId: 'data' },
    );

    assert.deepEqual(invalid, {
      block: true,
      blockReason:
        'Agent System blocked exec because the active manifest is invalid (manifest-schema).',
    });
    assert.equal(unmanaged, undefined);
  });

  it('should contribute literals normally and sentinels only in a reserved probe session', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerAgentSystemHooks(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
      } as never,
      {
        async loadForRuntimeContext() {
          return {
            status: 'loaded',
            scope: { agentId: 'data', workspaceDir: '/workspace' },
            path: '/workspace/agent.yaml',
            digest: 'abc123',
            manifest: {
              schemaVersion: 1,
              agent: { id: 'data' },
              environment: { set: { AGENT_COLOR: 'green' } },
            },
            environment: {
              values: { AGENT_COLOR: 'green' },
              variables: [
                {
                  name: 'AGENT_COLOR',
                  source: 'environment.set',
                  staticExecDelivery: 'exec-candidate',
                },
              ],
            },
            diagnostics: [],
          };
        },
      },
    );

    const ordinary = await handlers.get('resolve_exec_env')?.(
      { toolName: 'exec', host: 'gateway', sessionKey: 'agent:data:ordinary' },
      { agentId: 'data' },
    );
    const probe = await handlers.get('resolve_exec_env')?.(
      {
        toolName: 'exec',
        host: 'gateway',
        sessionKey: 'agent:data:agent-system-env-probe-11111111-2222-3333-4444-555555555555',
      },
      { agentId: 'data' },
    );

    assert.deepEqual(ordinary, { AGENT_COLOR: 'green' });
    assert.equal(
      ((probe as Record<string, string>).AGENT_COLOR ?? '').startsWith('agent-system-env-probe-'),
      true,
    );
  });
});
