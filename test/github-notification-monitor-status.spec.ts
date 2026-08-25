import assert from 'node:assert/strict';

import {
  evaluateGitHubNotificationWait,
  githubNotificationMonitorStatus,
} from '../channels/github/intake/monitor/status.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

describe('channels/github/intake/monitor/status', () => {
  it('should project prepared intake without private worktree values', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.intake = {
      ...item.intake!,
      stage: 'prepared',
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
      lifecycleId: 'issue',
      number: 12,
      reasonCode: 'assignment-approved',
      repository: 'tanaabased/example',
      stage: 'prepared',
      worktree: 'ready',
    });
    assert.equal(JSON.stringify(result).includes('/workspace/worktrees'), false);
    assert.deepEqual(evaluateGitHubNotificationWait(result, 'worktree-ready', selector), {
      code: 'github-notification-worktree-ready',
      status: 'reached',
    });
    assert.deepEqual(evaluateGitHubNotificationWait(result, 'prepared', selector), {
      code: 'github-notification-prepared',
      status: 'reached',
    });
  });

  it('should surface durable intake failures', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.intake = {
      ...item.intake!,
      failureCode: 'github-notification-worktree-failed',
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

  it('should project redacted cleanup checkpoints without managed resource values', () => {
    const state = notificationMonitorState();
    const item = state.items[notificationItemKey]!;
    item.disposition = 'retired';
    item.intake = {
      ...item.intake!,
      cleanup: {
        reasonCode: 'github-notification-cleanup-worktree-dirty',
        session: 'archived',
        status: 'skipped',
        worktree: 'dirty',
      },
      providerRetirementVerifiedAt: 10,
      stage: 'retired',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };

    const result = githubNotificationMonitorStatus('tanaabot', state);

    assert.deepEqual(result.items[0]?.cleanup, item.intake.cleanup);
    assert.equal(JSON.stringify(result).includes('/workspace/worktrees'), false);
    assert.equal(JSON.stringify(result).includes('agent/tanaabot'), false);
  });

  it('should report baseline and assignment rejection checkpoints', () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const item = state.items[notificationItemKey]!;
    item.disposition = 'rejected';
    item.reasonCode = 'assignment-actor-not-approved';
    delete item.intake;
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
