import assert from 'node:assert/strict';

import GitHubNotificationCommentService from '../channels/github/lib/comment-service.ts';
import { githubCommentRevision } from '../channels/github/utils/comment-admission.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import {
  notificationActor,
  notificationItemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

const context = {
  author: notificationActor,
  body: '@tanaabot status?',
  bodyTruncated: false,
  createdAt: '2026-08-14T12:00:00.000Z',
  databaseId: 91,
  nodeId: 'IC_comment',
  updatedAt: '2026-08-14T12:00:00.000Z',
};

function activeState(): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  const item = state.items[notificationItemKey]!;
  const revision = githubCommentRevision(context);
  item.delivery = {
    ...item.delivery!,
    acknowledgment: { commentId: 90, status: 'published' },
    activation: { status: 'planned' },
    sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
    stage: 'active',
    worktreeBranch: 'agent/tanaabot/issue-7',
    worktreePath: '/workspace/worktrees/issue-7',
  };
  item.commentTracking = {
    baselineAt: 1,
    revisions: {
      [context.nodeId]: {
        actorNodeId: notificationActor.nodeId,
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: context.databaseId,
        commentNodeId: context.nodeId,
        createdAt: Date.parse(context.createdAt),
        disposition: 'approved',
        reasonCode: 'comment-approved',
        revisionId: revision.revisionId,
        turn: { status: 'pending' },
        updatedAt: Date.parse(context.updatedAt),
      },
    },
  };
  return state;
}

function memoryStore(initial = activeState()) {
  let state = structuredClone(initial);
  return {
    read: async () => structuredClone(state),
    state: () => structuredClone(state),
    async write(next: GitHubNotificationMonitorState) {
      state = structuredClone(next);
    },
  };
}

function leaseStore() {
  return {
    async acquire() {
      return { lease: { release: async () => undefined }, status: 'acquired' as const };
    },
  };
}

const logger = { error() {}, info() {}, warn() {} };

describe('channels/github/lib/comment-service', () => {
  it('should checkpoint one adopted response and durable github reply', async () => {
    const store = memoryStore();
    let responses = 0;
    const service = new GitHubNotificationCommentService({
      authority: { loadCommentContext: async () => ({ authorized: true, context }) },
      leaseStore: leaseStore(),
      logger,
      sessions: {
        async respondToComment(input) {
          responses += 1;
          await input.onTurnAdopted();
          assert.equal(
            store.state().items[notificationItemKey]?.commentTracking?.revisions.IC_comment?.turn
              ?.status,
            'adopted',
          );
          return { reply: { commentId: 92, status: 'published' } };
        },
      },
      stateStore: store,
    });
    const controller = new AbortController();

    assert.equal(service.schedule('tanaabot', controller.signal), 'scheduled');
    assert.equal(service.schedule('tanaabot', controller.signal), 'already-scheduled');
    await service.settle('tanaabot');

    const revision =
      store.state().items[notificationItemKey]?.commentTracking?.revisions.IC_comment;
    assert.equal(responses, 1);
    assert.deepEqual(revision?.turn, { status: 'responded' });
    assert.deepEqual(revision?.reply, { commentId: 92, status: 'published' });
  });

  it('should reject stale authority without dispatching a model turn', async () => {
    const store = memoryStore();
    let responses = 0;
    const service = new GitHubNotificationCommentService({
      authority: {
        loadCommentContext: async () => ({
          authorized: false,
          reasonCode: 'github-notification-comment-revision-stale',
        }),
      },
      leaseStore: leaseStore(),
      logger,
      sessions: {
        async respondToComment() {
          responses += 1;
          throw new Error('must not dispatch');
        },
      },
      stateStore: store,
    });

    service.schedule('tanaabot', new AbortController().signal);
    await service.settle('tanaabot');

    const revision =
      store.state().items[notificationItemKey]?.commentTracking?.revisions.IC_comment;
    assert.equal(responses, 0);
    assert.equal(revision?.disposition, 'rejected');
    assert.equal(revision?.reasonCode, 'github-notification-comment-revision-stale');
  });

  it('should retry only failures before the host adopts the comment turn', async () => {
    const store = memoryStore();
    let attempts = 0;
    let adopt = false;
    const service = new GitHubNotificationCommentService({
      authority: { loadCommentContext: async () => ({ authorized: true, context }) },
      leaseStore: leaseStore(),
      logger,
      sessions: {
        async respondToComment(input) {
          attempts += 1;
          if (adopt) await input.onTurnAdopted();
          throw new Error('model failed');
        },
      },
      stateStore: store,
    });
    const signal = new AbortController().signal;

    service.schedule('tanaabot', signal);
    await service.settle('tanaabot');
    assert.equal(
      store.state().items[notificationItemKey]?.commentTracking?.revisions.IC_comment?.turn?.status,
      'pending',
    );

    adopt = true;
    service.schedule('tanaabot', signal);
    await service.settle('tanaabot');
    service.schedule('tanaabot', signal);
    await service.settle('tanaabot');

    assert.equal(attempts, 2);
    assert.equal(
      store.state().items[notificationItemKey]?.commentTracking?.revisions.IC_comment?.turn?.status,
      'failed',
    );
  });
});
