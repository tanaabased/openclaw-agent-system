import assert from 'node:assert/strict';

import {
  evaluateGitHubNotificationWait,
  githubNotificationMonitorStatus,
} from '../channels/github/utils/monitor-status.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

describe('channels/github/utils/monitor-status', () => {
  it('should project intake checkpoints without private delivery values', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      stage: 'worktree-ready',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    const selector = {
      itemType: 'issue' as const,
      number: 12,
      repository: 'tanaabased/example',
    };

    const result = githubNotificationMonitorStatus('tanaabot', state, selector);

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.items[0], {
      disposition: 'approved',
      itemType: 'issue',
      number: 12,
      reasonCode: 'assignment-approved',
      repository: 'tanaabased/example',
      stage: 'worktree-ready',
      worktree: 'ready',
    });
    assert.equal(JSON.stringify(result).includes('/workspace/worktrees'), false);
    assert.deepEqual(evaluateGitHubNotificationWait(result, 'worktree-ready', selector), {
      code: 'github-notification-worktree-ready',
      status: 'reached',
    });
  });

  it('should surface durable intake failures', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      failureCode: 'github-notification-worktree-failed',
      stage: 'received',
    };
    const selector = {
      itemType: 'issue' as const,
      number: 12,
      repository: 'tanaabased/example',
    };
    const result = githubNotificationMonitorStatus('tanaabot', state, selector);

    assert.deepEqual(evaluateGitHubNotificationWait(result, 'worktree-ready', selector), {
      code: 'github-notification-worktree-failed',
      status: 'failed',
    });
  });

  it('should report baseline and assignment rejection checkpoints', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.disposition = 'rejected';
    item.reasonCode = 'assignment-actor-not-approved';
    delete item.delivery;
    const selector = {
      itemType: 'issue' as const,
      number: 12,
      repository: 'tanaabased/example',
    };
    const result = githubNotificationMonitorStatus('tanaabot', state, selector);

    assert.deepEqual(evaluateGitHubNotificationWait(result, 'baseline-ready'), {
      code: 'github-notification-baseline-ready',
      status: 'reached',
    });
    assert.deepEqual(evaluateGitHubNotificationWait(result, 'assignment-rejected', selector), {
      code: 'github-notification-assignment-rejected',
      status: 'reached',
    });
  });
});
