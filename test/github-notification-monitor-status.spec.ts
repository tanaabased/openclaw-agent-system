import assert from 'node:assert/strict';

import {
  evaluateGitHubNotificationWait,
  githubNotificationMonitorStatus,
} from '../channels/github/utils/monitor-status.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

describe('channels/github/utils/monitor-status', () => {
  it('should project lifecycle checkpoints without private delivery values', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      acknowledgment: { commentId: 90, status: 'published' },
      activation: { reply: { commentId: 92, status: 'published' }, status: 'planned' },
      sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    item.commentTracking = {
      baselineAt: 2,
      revisions: {
        C_comment: {
          actorNodeId: 'U_actor',
          bodyDigest: 'a'.repeat(64),
          commentDatabaseId: 91,
          commentNodeId: 'C_comment',
          createdAt: 3,
          disposition: 'approved',
          reasonCode: 'comment-approved',
          reply: { commentId: 94, status: 'published' },
          revisionId: 'b'.repeat(64),
          turn: { status: 'responded' },
          updatedAt: 3,
        },
      },
    };

    const result = githubNotificationMonitorStatus('tanaabot', state, {
      itemType: 'issue',
      number: 12,
      repository: 'tanaabased/example',
    });

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.items[0], {
      acknowledgment: { commentId: 90, status: 'published' },
      comments: [
        {
          commentId: 91,
          disposition: 'approved',
          reasonCode: 'comment-approved',
          reply: { commentId: 94, status: 'published' },
          turn: { status: 'responded' },
        },
      ],
      disposition: 'approved',
      itemType: 'issue',
      mode: 'plan',
      number: 12,
      planning: { reply: { commentId: 92, status: 'published' }, status: 'planned' },
      reasonCode: 'assignment-approved',
      repository: 'tanaabased/example',
      session: 'recorded',
      stage: 'active',
      worktree: 'ready',
    });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('/workspace/worktrees'), false);
    assert.equal(serialized.includes('agent:tanaabot:'), false);
    assert.equal(serialized.includes('bodyDigest'), false);
    assert.deepEqual(
      evaluateGitHubNotificationWait(
        result,
        'comment-replied',
        { itemType: 'issue', number: 12, repository: 'tanaabased/example' },
        91,
      ),
      { code: 'github-notification-comment-replied', status: 'reached' },
    );
    assert.deepEqual(
      evaluateGitHubNotificationWait(result, 'assignment-acknowledged', {
        itemType: 'issue',
        number: 12,
        repository: 'tanaabased/example',
      }),
      {
        code: 'github-notification-assignment-acknowledged',
        status: 'reached',
      },
    );
    assert.deepEqual(
      evaluateGitHubNotificationWait(result, 'planning-replied', {
        itemType: 'issue',
        number: 12,
        repository: 'tanaabased/example',
      }),
      {
        code: 'github-notification-planning-replied',
        status: 'reached',
      },
    );
  });

  it('should treat later delivery stages as proof that receipt completed', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      activation: { status: 'pending' },
      sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    const selector = { itemType: 'issue' as const, number: 12, repository: 'tanaabased/example' };
    const result = githubNotificationMonitorStatus('tanaabot', state, selector);

    assert.equal(evaluateGitHubNotificationWait(result, 'received', selector).status, 'reached');
    assert.equal(evaluateGitHubNotificationWait(result, 'active', selector).status, 'reached');
    assert.equal(
      evaluateGitHubNotificationWait(result, 'planning-complete', selector).status,
      'pending',
    );
  });

  it('should surface durable terminal failures without waiting on presentation', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      activation: {
        failureCode: 'github-notification-planning-response-invalid',
        status: 'failed',
      },
      sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    const selector = { itemType: 'issue' as const, number: 12, repository: 'tanaabased/example' };
    const result = githubNotificationMonitorStatus('tanaabot', state, selector);

    assert.deepEqual(evaluateGitHubNotificationWait(result, 'planning-complete', selector), {
      code: 'github-notification-planning-response-invalid',
      status: 'failed',
    });
  });

  it('should report a public planning reply failure without invalidating the private plan', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      activation: {
        reply: {
          failureCode: 'github-notification-planning-reply-not-confirmed',
          status: 'failed',
        },
        status: 'planned',
      },
      sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    const selector = { itemType: 'issue' as const, number: 12, repository: 'tanaabased/example' };
    const result = githubNotificationMonitorStatus('tanaabot', state, selector);

    assert.equal(
      evaluateGitHubNotificationWait(result, 'planning-complete', selector).status,
      'reached',
    );
    assert.deepEqual(evaluateGitHubNotificationWait(result, 'planning-replied', selector), {
      code: 'github-notification-planning-reply-not-confirmed',
      status: 'failed',
    });
  });
});
