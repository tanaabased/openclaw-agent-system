import assert from 'node:assert/strict';

import type { AssembledInboundReply } from 'openclaw/plugin-sdk/channel-inbound';

import GitHubNotificationModelTurnDispatcher, {
  GitHubNotificationModelTurnDispatcherError,
} from '../channels/github/conversation/model-turn-dispatcher.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';

const route = {
  accountId: 'tanaabot',
  agentId: 'tanaabot',
  channel: githubNotificationChannelId,
  conversationId: 'github:issue:R_repo:12',
  matchedBy: 'binding.account',
  sessionKey: 'agent:tanaabot:agent-system-github:tanaabot:direct:github:issue:R_repo:12',
  workspaceDir: '/workspace/tanaabot',
} as const;
const ctxPayload = {} as AssembledInboundReply['ctxPayload'];

describe('channels/github/conversation/model-turn-dispatcher', () => {
  it('should record and dispatch one resolved model turn through the shared host boundary', async () => {
    let recorded = false;
    const dispatcher = new GitHubNotificationModelTurnDispatcher({
      async dispatchReplyWithBufferedBlockDispatcher(input) {
        assert.equal(recorded, true);
        assert.equal(input.replyOptions?.disableTools, false);
        const replyOptions = input.replyOptions as Record<string, unknown>;
        assert.equal(replyOptions.cleanupBundleMcpOnRunEnd, true);
        assert.equal(replyOptions.cleanupCliLiveSessionOnRunEnd, true);
        assert.equal(replyOptions.oneShotCliRun, true);
        await input.dispatcherOptions.deliver(
          { text: 'progress', isCommentary: true },
          {
            kind: 'block',
          },
        );
        await input.dispatcherOptions.deliver({ text: 'complete response' }, { kind: 'final' });
        return { counts: { block: 1, final: 1, tool: 0 }, queuedFinal: false };
      },
      async recordInboundSession(input) {
        input.trackSessionMetaTask?.(
          Promise.resolve().then(() => {
            recorded = true;
            return { sessionId: 'session-1' };
          }),
        );
      },
    });

    const result = await dispatcher.dispatch({
      config: {},
      contract: { mode: { disableTools: false, id: 'work' } },
      ctxPayload,
      executionSurface: 'cli-one-shot',
      messageId: 'comment:revision-1',
      route,
    });

    assert.deepEqual(result.dispatch, {
      counts: { block: 1, final: 1, tool: 0 },
      queuedFinal: false,
    });
    assert.deepEqual(result.finalPayloads, [{ text: 'complete response' }]);
  });

  it('should fail before model dispatch when the existing session is absent', async () => {
    let dispatches = 0;
    const dispatcher = new GitHubNotificationModelTurnDispatcher({
      async dispatchReplyWithBufferedBlockDispatcher() {
        dispatches += 1;
        return { counts: { block: 0, final: 0, tool: 0 }, queuedFinal: false };
      },
      async recordInboundSession(input) {
        input.trackSessionMetaTask?.(Promise.resolve(null));
      },
    });

    await assert.rejects(
      dispatcher.dispatch({
        config: {},
        contract: { mode: { disableTools: false, id: 'work' } },
        ctxPayload,
        executionSurface: 'gateway',
        messageId: 'comment:revision-1',
        route,
      }),
      (error: unknown) =>
        error instanceof GitHubNotificationModelTurnDispatcherError &&
        error.code === 'github-notification-model-turn-session-missing',
    );
    assert.equal(dispatches, 0);
  });
});
