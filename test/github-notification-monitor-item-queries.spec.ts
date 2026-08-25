import assert from 'node:assert/strict';

import {
  pendingGitHubNotificationItemKeys,
  preparedGitHubNotificationIssueItemKeys,
} from '../channels/github/intake/monitor/item-queries.ts';
import {
  approvedNotificationItem,
  approvedPullRequestNotificationItem,
  notificationItemKey,
  notificationMonitorState,
  notificationPullRequestItemKey,
} from './github-notification-fixtures.ts';

describe('channels/github/intake/monitor/item-queries', () => {
  it('should select only admitted approvals and incomplete retirements for intake', () => {
    const state = notificationMonitorState();
    const retiredKey = 'github:R_repo:14';
    const preparedKey = 'github:R_repo:15';
    const cleanupKey = 'github:R_repo:16';
    const completedKey = 'github:R_repo:17';
    const localRetirementKey = 'github:R_repo:18';
    const retired = approvedNotificationItem();
    retired.number = 14;
    retired.disposition = 'retired';
    const prepared = approvedNotificationItem();
    prepared.number = 15;
    prepared.intake = { ...prepared.intake!, stage: 'prepared' };
    const cleanup = approvedNotificationItem();
    cleanup.number = 16;
    cleanup.disposition = 'retired';
    cleanup.intake = {
      ...cleanup.intake!,
      cleanup: {
        reasonCode: 'github-notification-cleanup-worktree-dirty',
        session: 'archived',
        status: 'skipped',
        worktree: 'dirty',
      },
      providerRetirementVerifiedAt: 10,
      stage: 'retired',
    };
    const completed = structuredClone(cleanup);
    completed.number = 17;
    completed.intake!.cleanup = {
      reasonCode: 'github-notification-cleanup-worktree-removed',
      session: 'archived',
      status: 'completed',
      worktree: 'removed',
    };
    const localRetirement = approvedNotificationItem();
    localRetirement.number = 18;
    localRetirement.disposition = 'retired';
    localRetirement.intake = { ...localRetirement.intake!, stage: 'retired' };
    state.items[retiredKey] = retired;
    state.items[preparedKey] = prepared;
    state.items[cleanupKey] = cleanup;
    state.items[completedKey] = completed;
    state.items[localRetirementKey] = localRetirement;

    assert.deepEqual(pendingGitHubNotificationItemKeys(state), [
      notificationItemKey,
      retiredKey,
      cleanupKey,
    ]);
  });

  it('should select prepared issue responses through an exact item selector', () => {
    const state = notificationMonitorState();
    state.items[notificationItemKey]!.intake = {
      ...state.items[notificationItemKey]!.intake!,
      stage: 'prepared',
    };
    const pullRequest = approvedPullRequestNotificationItem();
    pullRequest.intake = { ...pullRequest.intake!, stage: 'prepared' };
    state.items[notificationPullRequestItemKey] = pullRequest;

    assert.deepEqual(
      preparedGitHubNotificationIssueItemKeys(state, {
        itemType: 'issue',
        number: 12,
        repository: 'TANAABASED/EXAMPLE',
      }),
      [notificationItemKey],
    );
  });
});
