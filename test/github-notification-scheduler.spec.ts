import assert from 'node:assert/strict';

import {
  claimGitHubNotificationIssueWork,
  queueGitHubNotificationIssueWork,
  waitGitHubNotificationIssueWork,
} from '../channels/github/intake/monitor/scheduler.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/intake/monitor/state.ts';
import {
  approvedNotificationItem,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

function burst(size = 20): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  state.items = {};
  state.nextSchedulingSequence = size + 1;
  for (let index = 1; index <= size; index += 1) {
    const item = approvedNotificationItem();
    item.assignmentEventNodeId = `EV_assignment_${index}`;
    item.intake = {
      assignmentEventId: item.assignmentEventNodeId,
      scheduling: { sequence: index, status: 'queued' },
      stage: 'admitted',
    };
    item.itemDatabaseId = index;
    item.itemNodeId = `I_item_${index}`;
    item.number = index;
    state.items[`github:${item.repositoryNodeId}:${item.number}`] = item;
  }
  return state;
}

describe('channels/github/intake/monitor/scheduler', () => {
  it('should claim only the configured capacity from a twenty-issue burst', () => {
    const claimed = claimGitHubNotificationIssueWork(burst(), 2);

    assert.deepEqual(claimed.itemKeys, ['github:R_repo:1', 'github:R_repo:2']);
    assert.equal(
      Object.values(claimed.state.items).filter(
        (item) => item.intake?.scheduling?.status === 'active',
      ).length,
      2,
    );
    assert.equal(
      Object.values(claimed.state.items).filter(
        (item) => item.intake?.scheduling?.status === 'queued',
      ).length,
      18,
    );
  });

  it('should retain active continuations and admit the next stable queue entry', () => {
    const first = claimGitHubNotificationIssueWork(burst(4), 2).state;
    waitGitHubNotificationIssueWork(
      first,
      'github:R_repo:1',
      'github-notification-pull-request-delivered',
    );

    const second = claimGitHubNotificationIssueWork(first, 2);

    assert.deepEqual(second.itemKeys, ['github:R_repo:2', 'github:R_repo:3']);
    assert.equal(second.state.items['github:R_repo:1']?.intake?.scheduling?.status, 'waiting');
  });

  it('should move retryable work behind unrelated queued issues', () => {
    const state = claimGitHubNotificationIssueWork(burst(3), 1).state;
    queueGitHubNotificationIssueWork(
      state,
      'github:R_repo:1',
      'github-notification-worktree-preparation-failed',
    );

    const next = claimGitHubNotificationIssueWork(state, 1);

    assert.deepEqual(next.itemKeys, ['github:R_repo:2']);
    assert.equal(
      next.state.items['github:R_repo:1']?.intake?.scheduling?.reasonCode,
      'github-notification-worktree-preparation-failed',
    );
  });

  it('should count another surface active claim before honoring a selector', () => {
    const state = claimGitHubNotificationIssueWork(burst(2), 1).state;
    const selected = claimGitHubNotificationIssueWork(state, 1, {
      itemType: 'issue',
      number: 2,
      repository: 'tanaabased/example',
    });

    assert.deepEqual(selected.itemKeys, []);
    assert.equal(selected.state.items['github:R_repo:2']?.intake?.scheduling?.status, 'queued');
  });

  it('should not let a targeted run jump the durable queue', () => {
    const selected = claimGitHubNotificationIssueWork(burst(3), 1, {
      itemType: 'issue',
      number: 3,
      repository: 'tanaabased/example',
    });

    assert.deepEqual(selected.itemKeys, []);
    assert.equal(selected.state.items['github:R_repo:3']?.intake?.scheduling?.status, 'queued');
  });
});
