import assert from 'node:assert/strict';

import decodeGitHubNotificationMonitorState from '../channels/github/utils/monitor-state-codec.ts';
import { notificationMonitorState } from './github-notification-fixtures.ts';

describe('channels/github/utils/monitor-state-codec', () => {
  it('should accept current value-free state and reject unknown fields', () => {
    const state = notificationMonitorState();

    assert.deepEqual(decodeGitHubNotificationMonitorState(state, state.agentId), {
      state,
      status: 'ready',
    });
    assert.equal(
      decodeGitHubNotificationMonitorState({ ...state, token: 'must-not-persist' }, state.agentId),
      undefined,
    );
  });

  it('should accept retirement while its prior delivery stage is still being reconciled', () => {
    const state = notificationMonitorState();
    state.items[Object.keys(state.items)[0]!]!.disposition = 'retired';
    state.items[Object.keys(state.items)[0]!]!.reasonCode = 'item-unassigned';

    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
  });

  it('should retain activation history when an active assignment retires', () => {
    const state = notificationMonitorState();
    const item = state.items[Object.keys(state.items)[0]!]!;
    item.disposition = 'retired';
    item.reasonCode = 'item-unassigned';
    item.delivery = {
      ...item.delivery!,
      acknowledgment: { commentId: 91, status: 'published' },
      activation: { status: 'planned' },
      sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
      stage: 'retired',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };

    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
  });

  it('should accept a terminal activation failure', () => {
    const state = notificationMonitorState();
    const item = state.items[Object.keys(state.items)[0]!]!;
    item.delivery = {
      ...item.delivery!,
      acknowledgment: { status: 'pending' },
      activation: {
        failureCode: 'github-notification-planning-response-invalid',
        status: 'failed',
      },
      sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };

    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
  });

  it('should accept only value-free terminal acknowledgment failures', () => {
    const state = notificationMonitorState();
    const item = state.items[Object.keys(state.items)[0]!]!;
    item.delivery = {
      ...item.delivery!,
      acknowledgment: {
        failureCode: 'github-notification-acknowledgment-not-confirmed',
        status: 'failed',
      },
      activation: { status: 'planned' },
      sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };

    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
    item.delivery.acknowledgment = {
      failureCode: 'provider failure with prose',
      status: 'failed',
    };
    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId), undefined);
  });

  it('should accept a session-recording checkpoint', () => {
    const state = notificationMonitorState();
    const item = state.items[Object.keys(state.items)[0]!]!;
    item.delivery = {
      ...item.delivery!,
      stage: 'session-recording',
      worktreeBranch: 'issue-7-branch',
      worktreePath: '/workspace/worktrees/issue-7',
    };

    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
  });

  it('should reject acknowledgment metadata before the active checkpoint', () => {
    const state = notificationMonitorState();
    const item = state.items[Object.keys(state.items)[0]!]!;
    item.delivery!.acknowledgment = { commentId: 91, status: 'published' };

    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId), undefined);
  });

  it('should accept bounded value-free comment checkpoints and reject persisted prose', () => {
    const state = notificationMonitorState();
    const item = state.items[Object.keys(state.items)[0]!]!;
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
      baselineAt: 2,
      revisions: {
        IC_comment: {
          actorNodeId: 'U_actor',
          bodyDigest: 'a'.repeat(64),
          commentDatabaseId: 92,
          commentNodeId: 'IC_comment',
          createdAt: 2,
          disposition: 'approved',
          reasonCode: 'comment-approved',
          reply: { commentId: 93, status: 'published' },
          revisionId: 'b'.repeat(64),
          turn: { status: 'responded' },
          updatedAt: 3,
        },
      },
    };

    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
    const unsafe = structuredClone(state) as unknown as {
      items: Record<string, { commentTracking: { revisions: Record<string, object> } }>;
    };
    unsafe.items[Object.keys(unsafe.items)[0]!]!.commentTracking.revisions.IC_comment = {
      ...unsafe.items[Object.keys(unsafe.items)[0]!]!.commentTracking.revisions.IC_comment,
      body: '@tanaabot private prose',
    };
    assert.equal(decodeGitHubNotificationMonitorState(unsafe, state.agentId), undefined);
  });

  it('should reject older state shapes instead of migrating them', () => {
    const state = notificationMonitorState();

    assert.equal(
      decodeGitHubNotificationMonitorState(
        { ...state, baselineItemNodeIds: [], schemaVersion: 2 },
        state.agentId,
      ),
      undefined,
    );
  });
});
