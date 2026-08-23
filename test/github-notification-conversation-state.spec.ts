import assert from 'node:assert/strict';

import {
  createGitHubNotificationConversationState,
  decodeGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
} from '../channels/github/conversation/conversation-state.ts';
import { githubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

describe('channels/github/conversation/conversation-state', () => {
  it('should migrate the legacy conversation schema without inventing an active turn', () => {
    const legacy = {
      agentId: 'notification-data',
      conversations: {
        'github:issue:R_repo:12': {
          baselineEstablished: true,
          itemKey: 'github:R_repo:12',
          lifecycleId: 'issue',
          mode: 'work',
          revisions: {},
        },
      },
      schemaVersion: 1,
      workspaceDir: '/workspace',
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(legacy, 'notification-data'), {
      ...legacy,
      schemaVersion: 4,
    });
  });

  it('should migrate the active-turn schema without inventing an acknowledgment', () => {
    const legacy = {
      agentId: 'notification-data',
      conversations: {
        'github:issue:R_repo:12': {
          activeTurn: { eventId: 'comment', sourceId: 'a'.repeat(64) },
          baselineEstablished: true,
          itemKey: 'github:R_repo:12',
          lifecycleId: 'issue',
          mode: 'work',
          revisions: {},
        },
      },
      schemaVersion: 2,
      workspaceDir: '/workspace',
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(legacy, 'notification-data'), {
      ...legacy,
      schemaVersion: 4,
    });
  });

  it('should retain one durable assignment acknowledgment without provider prose', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    const conversationId = 'github:issue:R_repo:12';
    const publicText = "Got it — I'm starting on this now.";
    state.conversations[conversationId] = {
      acknowledgment: {
        publicText,
        publicTextDigest: githubNotificationPublicTextDigest(publicText),
        status: 'pending',
        target: githubNotificationPublicationTarget({
          intent: 'initial-acknowledgment',
          item: approvedNotificationItem(),
          publicationId: 'EV_assignment',
        }),
      },
      baselineEstablished: false,
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
  });

  it('should retain one bounded active model turn', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    state.conversations['github:issue:R_repo:12'] = {
      activeTurn: { eventId: 'comment', sourceId: 'a'.repeat(64) },
      baselineEstablished: true,
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {
        IC_comment: {
          bodyDigest: 'b'.repeat(64),
          commentDatabaseId: 91,
          reasonCode: 'comment-approved',
          revisionId: 'a'.repeat(64),
          status: 'admitted',
        },
      },
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
    state.conversations['github:issue:R_repo:12']!.activeTurn!.sourceId = 'provider prose';
    assert.equal(decodeGitHubNotificationConversationState(state, 'notification-data'), undefined);
  });

  it('should retain one typed assignment planning outcome without private or provider prose', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    const conversationId = 'github:issue:R_repo:12';
    const publicText = 'I understand the user-facing failure and have a focused plan to fix it.';
    state.conversations[conversationId] = {
      baselineEstablished: true,
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      planning: {
        outcome: 'plan',
        publication: {
          publicText,
          publicTextDigest: githubNotificationPublicTextDigest(publicText),
          status: 'pending',
          target: githubNotificationPublicationTarget({
            intent: 'planning-outcome',
            item: approvedNotificationItem(),
            publicationId: 'EV_assignment',
          }),
        },
        sourceId: 'EV_assignment',
      },
      revisions: {},
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
  });

  it('should retain value-free comment receipts and one accepted public text', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    const conversationId = 'github:issue:R_repo:12';
    const source = { commentDatabaseId: 91, revisionId: 'a'.repeat(64) };
    const publicText = '## Ready\n\n- `LEIA-COMMENT` acknowledged.';
    state.conversations[conversationId] = {
      baselineEstablished: true,
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {
        IC_comment: {
          bodyDigest: 'b'.repeat(64),
          commentDatabaseId: 91,
          publication: {
            publicText,
            publicTextDigest: githubNotificationPublicTextDigest(publicText),
            status: 'pending',
            target: githubNotificationPublicationTarget({
              intent: 'github-reply',
              item: approvedNotificationItem(),
              source,
            }),
          },
          revisionId: source.revisionId,
          status: 'responded',
        },
      },
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
  });

  it('should preserve an empty established baseline', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    state.conversations['github:issue:R_repo:12'] = {
      baselineEstablished: true,
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };

    assert.equal(
      decodeGitHubNotificationConversationState(state, 'notification-data')?.conversations[
        'github:issue:R_repo:12'
      ]?.baselineEstablished,
      true,
    );
  });

  it('should reject unimplemented conversation modes', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    state.conversations['github:issue:R_repo:12'] = {
      baselineEstablished: true,
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'plan',
      revisions: {},
    };

    assert.equal(decodeGitHubNotificationConversationState(state, 'notification-data'), undefined);
  });

  it('should retain a withheld publication without storing private response text', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    state.conversations['github:issue:R_repo:12'] = {
      baselineEstablished: true,
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {
        IC_comment: {
          bodyDigest: 'b'.repeat(64),
          commentDatabaseId: 91,
          publication: {
            reasonCode: 'github-notification-publication-synthesis-invalid',
            status: 'withheld',
          },
          reasonCode: 'comment-approved',
          revisionId: 'a'.repeat(64),
          status: 'responded',
        },
      },
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
  });

  it('should reject mismatched public text digests and provider prose fields', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    state.conversations['github:issue:R_repo:12'] = {
      baselineEstablished: true,
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {
        IC_comment: {
          bodyDigest: 'b'.repeat(64),
          commentDatabaseId: 91,
          reasonCode: 'comment-approved',
          revisionId: 'a'.repeat(64),
          status: 'admitted',
        },
      },
    };
    (
      state.conversations['github:issue:R_repo:12']!.revisions.IC_comment as unknown as Record<
        string,
        unknown
      >
    ).body = 'provider prose';

    assert.equal(decodeGitHubNotificationConversationState(state, 'notification-data'), undefined);
  });
});
