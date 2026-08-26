import assert from 'node:assert/strict';

import {
  createGitHubNotificationConversationState,
  decodeGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
} from '../channels/github/conversation/conversation-state.ts';
import { githubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

const issueSource = { itemType: 'issue' as const, number: 12 };

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

    const decoded = decodeGitHubNotificationConversationState(legacy, 'notification-data');
    assert.equal(decoded?.schemaVersion, 7);
    assert.equal(decoded?.conversations['github:issue:R_repo:12']?.deliveryPullRequest, undefined);
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

    const decoded = decodeGitHubNotificationConversationState(legacy, 'notification-data');
    assert.equal(decoded?.schemaVersion, 7);
    assert.equal(decoded?.conversations['github:issue:R_repo:12']?.deliveryPullRequest, undefined);
  });

  it('should migrate the acknowledgment schema without inventing an assignment response', () => {
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
      schemaVersion: 3,
      workspaceDir: '/workspace',
    };

    const decoded = decodeGitHubNotificationConversationState(legacy, 'notification-data');
    assert.equal(decoded?.schemaVersion, 7);
    assert.equal(decoded?.conversations['github:issue:R_repo:12']?.deliveryPullRequest, undefined);
  });

  it('should migrate the assignment-response schema without inventing implementation work', () => {
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
      schemaVersion: 4,
      workspaceDir: '/workspace',
    };

    const decoded = decodeGitHubNotificationConversationState(legacy, 'notification-data');
    assert.equal(decoded?.schemaVersion, 7);
    assert.equal(decoded?.conversations['github:issue:R_repo:12']?.deliveryPullRequest, undefined);
  });

  it('should migrate completed implementation state without inventing delivery receipts', () => {
    const legacy = {
      agentId: 'notification-data',
      conversations: {
        'github:issue:R_repo:12': {
          assignmentResponse: {
            commentDatabaseId: 44,
            commentNodeId: 'IC_assignment-response',
            publicText: 'I have a plan.',
            publicTextDigest: githubNotificationPublicTextDigest('I have a plan.'),
            status: 'published',
            target: githubNotificationPublicationTarget({
              intent: 'assignment-response',
              item: approvedNotificationItem(),
              publicationId: 'EV_assignment',
            }),
          },
          baselineEstablished: true,
          implementation: { status: 'completed' },
          itemKey: 'github:R_repo:12',
          lifecycleId: 'issue',
          mode: 'work',
          revisions: {},
        },
      },
      schemaVersion: 5,
      workspaceDir: '/workspace',
    };

    const decoded = decodeGitHubNotificationConversationState(legacy, 'notification-data');
    assert.equal(decoded?.schemaVersion, 7);
    assert.equal(
      decoded?.conversations['github:issue:R_repo:12']?.assignmentResponse?.status,
      'published',
    );
    assert.equal(decoded?.conversations['github:issue:R_repo:12']?.deliveryPullRequest, undefined);
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
          source: issueSource,
          status: 'admitted',
        },
      },
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
    state.conversations['github:issue:R_repo:12']!.activeTurn!.sourceId = 'provider prose';
    assert.equal(decodeGitHubNotificationConversationState(state, 'notification-data'), undefined);
  });

  it('should retain one assignment response in the shared publication envelope', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    const publicText = 'I reviewed the assignment and have a plan ready.';
    state.conversations['github:issue:R_repo:12'] = {
      assignmentResponse: {
        publicText,
        publicTextDigest: githubNotificationPublicTextDigest(publicText),
        status: 'pending',
        target: githubNotificationPublicationTarget({
          intent: 'assignment-response',
          item: approvedNotificationItem(),
          publicationId: 'EV_assignment',
        }),
      },
      baselineEstablished: true,
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
  });

  it('should retain only bounded implementation scheduling state', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    const publicText = "The fixture is missing. I'm going to add it to resolve the issue.";
    state.conversations['github:issue:R_repo:12'] = {
      assignmentResponse: {
        publicText,
        publicTextDigest: githubNotificationPublicTextDigest(publicText),
        status: 'pending',
        target: githubNotificationPublicationTarget({
          intent: 'assignment-response',
          item: approvedNotificationItem(),
          publicationId: 'EV_assignment',
        }),
      },
      baselineEstablished: true,
      implementation: { status: 'pending' },
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
    state.conversations['github:issue:R_repo:12']!.implementation = {
      status: 'delivery-pending',
    };
    assert.equal(decodeGitHubNotificationConversationState(state, 'notification-data'), undefined);
    const response = state.conversations['github:issue:R_repo:12']!.assignmentResponse;
    if (response?.status !== 'pending') throw new Error('missing pending assignment response');
    state.conversations['github:issue:R_repo:12']!.assignmentResponse = {
      ...response,
      commentDatabaseId: 44,
      commentNodeId: 'IC_assignment-response',
      status: 'published',
    };
    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
    state.conversations['github:issue:R_repo:12']!.implementation = {
      status: 'completed',
    };
    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
    (
      state.conversations['github:issue:R_repo:12']!.implementation as unknown as Record<
        string,
        unknown
      >
    ).detail = 'provider prose';
    assert.equal(decodeGitHubNotificationConversationState(state, 'notification-data'), undefined);
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
          source: issueSource,
          status: 'responded',
        },
      },
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
  });

  it('should retain one bounded delivery pull request and source-affine publications', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    const conversationId = 'github:issue:R_repo:12';
    const pullRequestSource = { itemType: 'pull-request' as const, number: 45 };
    const handoffText = [
      '## Pull request opened',
      '',
      '- **Pull request:** #45',
      '- **Conversation:** Comments on this issue and the pull request now continue in the same private work session.',
      '- **Replies:** Each response is posted back to the issue or pull request where its comment originated.',
    ].join('\n');
    const replyText = '{{commenter}}, the pull request comment is handled here.';
    const revisionId = 'a'.repeat(64);
    state.conversations[conversationId] = {
      baselineEstablished: true,
      deliveryPullRequest: {
        baselineEstablished: true,
        eventRecorded: true,
        handoff: {
          commentDatabaseId: 101,
          commentNodeId: 'IC_handoff',
          publicText: handoffText,
          publicTextDigest: githubNotificationPublicTextDigest(handoffText),
          status: 'published',
          target: githubNotificationPublicationTarget({
            conversationId,
            intent: 'pull-request-handoff',
            publicationId: 'PR_delivery',
          }),
        },
        nodeId: 'PR_delivery',
        number: 45,
        status: 'open',
      },
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {
        IC_pull_request_comment: {
          bodyDigest: 'b'.repeat(64),
          commentDatabaseId: 102,
          publication: {
            publicText: replyText,
            publicTextDigest: githubNotificationPublicTextDigest(replyText),
            status: 'pending',
            target: githubNotificationPublicationTarget({
              conversationId,
              intent: 'github-reply',
              source: { commentDatabaseId: 102, revisionId },
            }),
          },
          revisionId,
          source: pullRequestSource,
          status: 'responded',
        },
      },
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
  });

  it('should retain an owner-affine direct pull request revision without delivery state', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    state.conversations['github:pull-request:R_repo:13'] = {
      baselineEstablished: true,
      itemKey: 'github:R_repo:13',
      lifecycleId: 'pull-request',
      mode: 'work',
      revisions: {
        IC_pull_request_comment: {
          bodyDigest: 'b'.repeat(64),
          commentDatabaseId: 102,
          reasonCode: 'comment-baseline',
          revisionId: 'a'.repeat(64),
          source: { itemType: 'pull-request', number: 13 },
          status: 'baseline',
        },
      },
    };

    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
  });

  it('should reject revisions redirected beyond the owner and delivery pull request', () => {
    const state = createGitHubNotificationConversationState('notification-data', '/workspace');
    const conversationId = 'github:issue:R_repo:12';
    state.conversations[conversationId] = {
      baselineEstablished: true,
      deliveryPullRequest: {
        baselineEstablished: true,
        eventRecorded: true,
        nodeId: 'PR_delivery',
        number: 45,
        status: 'open',
      },
      itemKey: 'github:R_repo:12',
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {
        IC_pull_request_comment: {
          bodyDigest: 'b'.repeat(64),
          commentDatabaseId: 102,
          publication: {
            publicText: 'This reply must stay on its source pull request.',
            publicTextDigest: githubNotificationPublicTextDigest(
              'This reply must stay on its source pull request.',
            ),
            status: 'pending',
            target: githubNotificationPublicationTarget({
              conversationId,
              intent: 'github-reply',
              source: { commentDatabaseId: 102, revisionId: 'a'.repeat(64) },
            }),
          },
          revisionId: 'a'.repeat(64),
          source: { itemType: 'pull-request', number: 46 },
          status: 'responded',
        },
      },
    };

    assert.equal(decodeGitHubNotificationConversationState(state, 'notification-data'), undefined);
    state.conversations[conversationId]!.revisions.IC_pull_request_comment!.source.number = 45;
    assert.deepEqual(decodeGitHubNotificationConversationState(state, 'notification-data'), state);
    state.conversations[conversationId]!.lifecycleId = 'pull-request';
    assert.equal(decodeGitHubNotificationConversationState(state, 'notification-data'), undefined);
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
          source: issueSource,
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
          source: issueSource,
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
