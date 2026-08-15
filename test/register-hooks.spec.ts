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
      { clear() {}, resolve: () => undefined },
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
    const logs: string[] = [];
    const warnings: string[] = [];
    const cleared: Array<string | undefined> = [];
    registerAgentSystemHooks(
      {
        logger: {
          info(message: string) {
            logs.push(message);
          },
          warn(message: string) {
            warnings.push(message);
          },
        },
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
      {
        clear(runId) {
          cleared.push(runId);
        },
        resolve(runId) {
          return runId === 'notification-run'
            ? {
                assignmentKind: 'issue',
                event: 'comment-received',
                mode: 'plan',
              }
            : undefined;
        },
      },
    );

    const injected = await handlers.get('before_prompt_build')?.(
      {},
      { messageProvider: 'agent-system-github', runId: 'notification-run' },
    );
    const ignored = await handlers.get('before_prompt_build')?.(
      {},
      { messageProvider: 'imessage', runId: 'notification-run' },
    );
    const mismatchedProvider = await handlers.get('before_prompt_build')?.(
      {},
      {
        channel: 'agent-system-github',
        messageProvider: 'github',
        runId: 'notification-run',
      },
    );
    await handlers.get('before_prompt_build')?.({}, { messageProvider: 'agent-system-github' });
    await handlers.get('agent_end')?.({}, { runId: 'notification-run' });

    assert.match(
      String((injected as { appendSystemContext?: string })?.appendSystemContext),
      /Continue the assigned GitHub issue conversation in Plan mode/u,
    );
    assert.equal(ignored, undefined);
    assert.equal(mismatchedProvider, undefined);
    assert.deepEqual(logs, [
      'github-notifications: prompt instructions applied code=github-notification-instructions-applied assignment=issue event=comment-received mode=plan',
    ]);
    assert.deepEqual(warnings, [
      'github-notifications: prompt instructions unresolved code=github-notification-instructions-unresolved',
    ]);
    assert.deepEqual(cleared, ['notification-run']);
  });
});
