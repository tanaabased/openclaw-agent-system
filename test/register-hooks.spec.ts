import assert from 'node:assert/strict';

import { agentCommandSecurityGuidance } from '../lib/agent-command-security.ts';
import registerAgentSystemHooks from '../lib/register-hooks.ts';

describe('lib/register-hooks', () => {
  it('should load manifest metadata for lifecycle and prompt hooks', async () => {
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
      { guidance: () => [] },
      { clear() {}, resolve: () => undefined },
    );

    await handlers.get('session_start')?.({}, { agentId: 'tanaabot', sessionId: 'one' });
    await handlers.get('before_prompt_build')?.({}, { agentId: 'tanaabot', sessionId: 'one' });

    assert.deepEqual([...handlers.keys()], ['session_start', 'before_prompt_build', 'agent_end']);
    assert.deepEqual(calls, [
      { agentId: 'tanaabot', trigger: 'session_start' },
      { agentId: 'tanaabot', trigger: 'before_prompt_build' },
    ]);
  });

  it('should append run-correlated github notification instructions invisibly', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const cleared: string[] = [];
    registerAgentSystemHooks(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
      } as never,
      {
        async loadForRuntimeContext() {
          return { status: 'unresolved', diagnostics: [] };
        },
      },
      { guidance: () => [] },
      {
        clear(runId) {
          if (runId) cleared.push(runId);
        },
        resolve: (runId) =>
          runId === 'run-one' || runId === 'run-two' ? 'Hidden response contract.' : undefined,
      },
    );

    const providerResult = await handlers.get('before_prompt_build')?.(
      {},
      {
        agentId: 'notification-data',
        messageProvider: 'agent-system-github',
        runId: 'run-one',
      },
    );
    const channelResult = await handlers.get('before_prompt_build')?.(
      {},
      {
        agentId: 'notification-data',
        channel: 'agent-system-github',
        runId: 'run-two',
      },
    );
    await handlers.get('agent_end')?.({}, { runId: 'run-one' });
    await handlers.get('agent_end')?.({}, { runId: 'run-two' });

    assert.deepEqual(providerResult, { appendSystemContext: 'Hidden response contract.' });
    assert.deepEqual(channelResult, { appendSystemContext: 'Hidden response contract.' });
    assert.deepEqual(cleared, ['run-one', 'run-two']);
  });

  it('should append central and configured tool guidance for the active manifest', async () => {
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
            digest: 'digest',
            manifest: { schemaVersion: 1, agent: { id: 'data' } },
            diagnostics: [],
            validationChecks: [],
          } as const;
        },
      },
      { guidance: () => ['Prefer the configured Agent System tool.'] },
    );

    const result = await handlers.get('before_prompt_build')?.(
      {},
      { agentId: 'data', sessionId: 'one' },
    );

    assert.deepEqual(result, {
      appendSystemContext: `${agentCommandSecurityGuidance}\nPrefer the configured Agent System tool.`,
    });
  });
});
