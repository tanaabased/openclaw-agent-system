import assert from 'node:assert/strict';

import registerAgentSystemHooks from '../lib/register-hooks.ts';

describe('lib/register-hooks', () => {
  it('should load manifest metadata only when a session starts', async () => {
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

    assert.deepEqual([...handlers.keys()], ['session_start']);
    assert.deepEqual(calls, [{ agentId: 'tanaabot', trigger: 'session_start' }]);
  });
});
