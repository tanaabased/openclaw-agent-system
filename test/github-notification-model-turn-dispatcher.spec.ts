import assert from 'node:assert/strict';

import type { ChannelInboundTurnPlan } from 'openclaw/plugin-sdk/channel-inbound';

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
const ctxPayload = {} as ChannelInboundTurnPlan['ctxPayload'];

describe('channels/github/conversation/model-turn-dispatcher', () => {
  it('should record and dispatch one resolved model turn through the shared host boundary', async () => {
    let recorded = false;
    const dispatcher = new GitHubNotificationModelTurnDispatcher({
      async dispatchChannelInboundTurn(input) {
        assert.equal(input.record?.createIfMissing, true);
        input.record?.trackSessionMetaTask?.(
          Promise.resolve().then(() => {
            recorded = true;
            return { sessionId: 'session-1' };
          }),
        );
        await input.afterRecord?.();
        assert.equal(recorded, true);
        assert.equal(input.ctxPayload.GroupSystemPrompt, 'trusted notification instructions');
        assert.equal(input.replyOptions?.disableTools, false);
        const replyOptions = input.replyOptions as Record<string, unknown>;
        assert.equal(replyOptions.extraSystemPrompt, undefined);
        assert.equal(replyOptions.cleanupBundleMcpOnRunEnd, true);
        assert.equal(replyOptions.cleanupCliLiveSessionOnRunEnd, true);
        assert.equal(replyOptions.oneShotCliRun, true);
        const commentaryPayload = await input.delivery.preparePayload?.(
          { text: 'progress', isCommentary: true },
          {
            kind: 'block',
          },
        );
        const finalPayload = await input.delivery.preparePayload?.(
          { text: 'complete response' },
          { kind: 'final' },
        );
        assert.equal(commentaryPayload, null);
        assert.equal(finalPayload, null);
        return {
          admission: { kind: 'dispatch' },
          ctxPayload: input.ctxPayload,
          dispatched: true,
          dispatchResult: { counts: { block: 1, final: 1, tool: 0 }, queuedFinal: false },
          routeSessionKey: input.route.sessionKey,
        } as never;
      },
    });

    const result = await dispatcher.dispatch({
      config: {},
      contract: {
        instructions: 'trusted notification instructions',
        mode: { disableTools: false, id: 'work' },
      },
      createIfMissing: true,
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
    const dispatcher = new GitHubNotificationModelTurnDispatcher({
      async dispatchChannelInboundTurn(input) {
        assert.equal(input.record?.createIfMissing, false);
        input.record?.trackSessionMetaTask?.(Promise.resolve(null));
        await input.afterRecord?.();
        throw new Error('unexpected model dispatch');
      },
    });

    await assert.rejects(
      dispatcher.dispatch({
        config: {},
        contract: {
          instructions: 'trusted notification instructions',
          mode: { disableTools: false, id: 'work' },
        },
        ctxPayload,
        executionSurface: 'gateway',
        messageId: 'comment:revision-1',
        route,
      }),
      (error: unknown) =>
        error instanceof GitHubNotificationModelTurnDispatcherError &&
        error.code === 'github-notification-model-turn-session-missing',
    );
  });
});
