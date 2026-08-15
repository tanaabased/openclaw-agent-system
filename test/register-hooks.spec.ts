import assert from 'node:assert/strict';
import { buildChannelInboundEventContext } from 'openclaw/plugin-sdk/channel-inbound';

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
    const logs: string[] = [];
    const warnings: string[] = [];
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
    );
    const inbound = buildChannelInboundEventContext({
      channel: 'agent-system-github',
      channelContext: {
        chat: {
          agentSystemGitHubNotification: {
            assignmentKind: 'issue',
            event: 'comment-received',
            mode: 'plan',
          },
          id: 'github-issue',
        },
        sender: { id: 'github-actor' },
      },
      conversation: {
        id: 'github-issue',
        kind: 'direct',
        routePeer: { id: 'github-issue', kind: 'direct' },
      },
      from: 'github:github-actor',
      message: { body: 'status?', rawBody: 'status?' },
      reply: { to: 'github-issue' },
      route: { agentId: 'data', routeSessionKey: 'agent:data:github-issue' },
      sender: { id: 'github-actor' },
    });
    const channelContext = inbound.ChannelContext;

    const injected = await handlers.get('before_prompt_build')?.(
      {},
      { channelContext, messageProvider: 'agent-system-github' },
    );
    const ignored = await handlers.get('before_prompt_build')?.(
      {},
      { channelContext, messageProvider: 'imessage' },
    );
    const mismatchedProvider = await handlers.get('before_prompt_build')?.(
      {},
      {
        channel: 'agent-system-github',
        channelContext,
        messageProvider: 'github',
      },
    );
    await handlers.get('before_prompt_build')?.({}, { messageProvider: 'agent-system-github' });

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
  });
});
