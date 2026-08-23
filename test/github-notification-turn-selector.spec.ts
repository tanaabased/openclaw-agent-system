import assert from 'node:assert/strict';

import {
  createGitHubNotificationConversationState,
  type GitHubNotificationConversationState,
} from '../channels/github/conversation/conversation-state.ts';
import GitHubNotificationTurnCatalog, {
  githubNotificationSupportedTurnIdentities,
} from '../channels/github/conversation/turn-catalog.ts';
import GitHubNotificationTurnSelector from '../channels/github/conversation/turn-selector.ts';
import { createGitHubNotificationTurnDefinitions } from './github-notification-turn-fixtures.ts';

const agentId = 'tanaabot';
const conversationId = 'github:issue:R_repo:12';
const workspaceDir = '/workspace/tanaabot';

function conversationState(active = true): GitHubNotificationConversationState {
  const state = createGitHubNotificationConversationState(agentId, workspaceDir);
  state.conversations[conversationId] = {
    ...(active ? { activeTurn: { eventId: 'comment' as const, sourceId: 'a'.repeat(64) } } : {}),
    baselineEstablished: true,
    itemKey: 'github:R_repo:12',
    lifecycleId: 'issue',
    mode: 'work',
    revisions: {},
  };
  return state;
}

describe('channels/github/conversation/turn-selector', () => {
  it('should select one catalogued turn from durable state and trusted routing', async () => {
    const reads: string[] = [];
    const resolved: unknown[] = [];
    const state = conversationState();
    const selector = new GitHubNotificationTurnSelector({
      conversations: {
        async read(selectedAgentId) {
          reads.push(selectedAgentId);
          return structuredClone(state);
        },
      },
      logger: { warn() {} },
      turns: {
        resolve(identity) {
          resolved.push(identity);
          return { identity };
        },
      },
    });

    assert.deepEqual(
      await selector.select({
        agentId: 'Tanaabot',
        channelId: conversationId,
        chatId: conversationId,
        workspaceDir,
      }),
      {
        agentId,
        conversationId,
        identity: { eventId: 'comment', lifecycleId: 'issue', modeId: 'work' },
        sourceId: 'a'.repeat(64),
      },
    );
    assert.deepEqual(reads, [agentId]);
    assert.deepEqual(resolved, [{ eventId: 'comment', lifecycleId: 'issue', modeId: 'work' }]);
  });

  it('should select the registered assignment tuple from durable state', async () => {
    const state = conversationState();
    state.conversations[conversationId]!.activeTurn = {
      eventId: 'assignment',
      sourceId: 'EV_assignment',
    };
    const catalog = new GitHubNotificationTurnCatalog(
      githubNotificationSupportedTurnIdentities,
      createGitHubNotificationTurnDefinitions(),
    );
    const selector = new GitHubNotificationTurnSelector({
      conversations: { read: async () => structuredClone(state) },
      logger: { warn() {} },
      turns: catalog,
    });

    assert.deepEqual(await selector.select({ agentId, channelId: conversationId }), {
      agentId,
      conversationId,
      identity: { eventId: 'assignment', lifecycleId: 'issue', modeId: 'work' },
      sourceId: 'EV_assignment',
    });
  });

  it('should decline missing, conflicting, or cross-workspace selection', async () => {
    const state = conversationState();
    let reads = 0;
    const selector = new GitHubNotificationTurnSelector({
      conversations: {
        async read() {
          reads += 1;
          return structuredClone(state);
        },
      },
      logger: { warn() {} },
      turns: {
        resolve(identity) {
          return { identity };
        },
      },
    });

    assert.equal(await selector.select({ channelId: conversationId }), undefined);
    assert.equal(
      await selector.select({
        agentId,
        channelId: conversationId,
        chatId: 'github:issue:R_repo:13',
      }),
      undefined,
    );
    assert.equal(
      await selector.select({
        agentId,
        channelId: conversationId,
        workspaceDir: '/workspace/other',
      }),
      undefined,
    );
    assert.equal(reads, 1);
  });

  it('should decline a conversation without an active turn', async () => {
    const selector = new GitHubNotificationTurnSelector({
      conversations: { read: async () => conversationState(false) },
      logger: { warn() {} },
      turns: {
        resolve() {
          throw new Error('inactive conversations must not resolve a turn');
        },
      },
    });

    assert.equal(await selector.select({ agentId, channelId: conversationId }), undefined);
  });

  it('should contain state and catalog failures behind one stable diagnostic', async () => {
    const warnings: string[] = [];
    const stateSelector = new GitHubNotificationTurnSelector({
      conversations: {
        async read() {
          throw new Error('private state contents must not escape');
        },
      },
      logger: { warn: (message) => warnings.push(message) },
      turns: {
        resolve(identity) {
          return { identity };
        },
      },
    });
    const catalogSelector = new GitHubNotificationTurnSelector({
      conversations: { read: async () => conversationState() },
      logger: { warn: (message) => warnings.push(message) },
      turns: {
        resolve() {
          throw new Error('catalog contents must not escape');
        },
      },
    });

    assert.equal(await stateSelector.select({ agentId, channelId: conversationId }), undefined);
    assert.equal(await catalogSelector.select({ agentId, channelId: conversationId }), undefined);
    assert.deepEqual(warnings, [
      'github-notifications: turn selection failed code=github-notification-turn-selection-failed',
      'github-notifications: turn selection failed code=github-notification-turn-selection-failed',
    ]);
  });
});
