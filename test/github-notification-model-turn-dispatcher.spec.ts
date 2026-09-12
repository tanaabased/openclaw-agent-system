import assert from 'node:assert/strict';

import type { ChannelInboundTurnPlan } from 'openclaw/plugin-sdk/channel-inbound';

import GitHubNotificationModelTurnDispatcher, {
  GitHubNotificationModelTurnDispatcherError,
} from '../channels/github/conversation/model-turn-dispatcher.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import { ModelRoutingError } from '../channels/github/conversation/model-routing.ts';

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
  it('should apply routing after recording and verify both native selections before publication', async () => {
    for (const actual of [
      { provider: 'openai', model: 'selected', thinkLevel: 'medium' },
      { provider: 'openai', model: 'fallback', thinkLevel: 'medium' },
      { provider: 'openai', model: 'selected', thinkLevel: 'high' },
      undefined,
    ] as const) {
      let applied = false;
      let recorded = false;
      const dispatcher = new GitHubNotificationModelTurnDispatcher({
        modelRouting: {
          async apply(selectedRoute) {
            assert.equal(recorded, true);
            assert.equal(selectedRoute, route);
            applied = true;
            return {
              expected: { model: 'openai/selected', effort: 'medium' },
              guidance: 'saved private routing',
            };
          },
        },
        async dispatchChannelInboundTurn(input) {
          input.record?.trackSessionMetaTask?.(
            Promise.resolve().then(() => {
              recorded = true;
              return {};
            }),
          );
          await input.afterRecord?.();
          assert.equal(applied, true);
          assert.match(input.ctxPayload.GroupSystemPrompt ?? '', /saved private routing/);
          if (actual) {
            try {
              input.replyOptions?.onModelSelected?.(actual);
            } catch (error) {
              assert.ok(error instanceof ModelRoutingError);
              assert.equal(input.replyOptions?.abortSignal?.aborted, true);
              // Even a host that catches callback errors must not allow publication.
            }
          }
          await input.delivery.deliver({ text: 'private result' }, { kind: 'final' });
          return {
            dispatched: true,
            routeSessionKey: route.sessionKey,
            dispatchResult: { counts: { final: 1, block: 0, tool: 0 }, queuedFinal: false },
          } as never;
        },
      });
      const result = dispatcher.dispatch({
        config: {},
        ctxPayload,
        executionSurface: 'cli-one-shot',
        messageId: 'assignment:1',
        route,
        contract: {
          instructions: 'assignment',
          mode: { id: 'work', disableTools: false },
          identity: { lifecycleId: 'issue', modeId: 'work', eventId: 'assignment' },
        },
      });
      if (actual?.model === 'selected' && actual.thinkLevel === 'medium')
        assert.equal((await result).finalPayloads.length, 1);
      else
        await assert.rejects(
          result,
          (error: unknown) =>
            error instanceof ModelRoutingError &&
            error.code ===
              (actual
                ? 'github-notification-routing-effective-mismatch'
                : 'github-notification-routing-effective-unverified'),
        );
    }
  });

  it('should record and dispatch one resolved model turn through the shared host boundary', async () => {
    let recorded = false;
    let acknowledged = false;
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
        assert.equal(acknowledged, true);
        assert.equal(input.ctxPayload.GroupSystemPrompt, 'trusted notification instructions');
        assert.equal(input.replyOptions?.disableTools, false);
        const replyOptions = input.replyOptions as Record<string, unknown>;
        assert.equal(replyOptions.extraSystemPrompt, undefined);
        assert.equal(replyOptions.cleanupBundleMcpOnRunEnd, true);
        assert.equal(replyOptions.cleanupCliLiveSessionOnRunEnd, true);
        assert.equal(replyOptions.oneShotCliRun, true);
        const commentaryDelivery = await input.delivery.deliver(
          { text: 'progress', isCommentary: true },
          {
            kind: 'block',
          },
        );
        const finalDelivery = await input.delivery.deliver(
          { text: 'complete response' },
          { kind: 'final' },
        );
        assert.deepEqual(commentaryDelivery, {
          suppression: { reason: 'channel_transform' },
          visibleReplySent: false,
        });
        assert.deepEqual(finalDelivery, {
          suppression: { reason: 'channel_transform' },
          visibleReplySent: false,
        });
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
      afterRecord: async () => {
        assert.equal(recorded, true);
        acknowledged = true;
      },
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
        afterRecord: async () => {
          assert.fail('missing sessions must not be acknowledged');
        },
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
