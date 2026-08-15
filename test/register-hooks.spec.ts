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
    );

    await handlers.get('session_start')?.({}, { agentId: 'tanaabot', sessionId: 'one' });
    await handlers.get('before_prompt_build')?.({}, { agentId: 'tanaabot', sessionId: 'one' });

    assert.deepEqual([...handlers.keys()], ['session_start', 'before_prompt_build']);
    assert.deepEqual(calls, [
      { agentId: 'tanaabot', trigger: 'session_start' },
      { agentId: 'tanaabot', trigger: 'before_prompt_build' },
    ]);
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

  it('should inject github notification instructions only for the matching channel turn', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerAgentSystemHooks(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
      } as never,
      {
        async loadForRuntimeContext() {
          return { status: 'unresolved', diagnostics: [] } as const;
        },
      },
      { guidance: () => [] },
    );
    const channelContext = {
      agentSystemGitHubNotification: {
        assignmentKind: 'issue',
        event: 'comment-received',
        mode: 'plan',
      },
    };

    const injected = await handlers.get('before_prompt_build')?.(
      {},
      { channelContext, messageProvider: 'agent-system-github' },
    );
    const ignored = await handlers.get('before_prompt_build')?.(
      {},
      { channelContext, messageProvider: 'imessage' },
    );

    assert.match(
      String((injected as { appendSystemContext?: string })?.appendSystemContext),
      /Continue the assigned GitHub issue conversation in Plan mode/u,
    );
    assert.equal(ignored, undefined);
  });
});
