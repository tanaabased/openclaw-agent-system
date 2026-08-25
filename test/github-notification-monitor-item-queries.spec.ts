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
    const retired = approvedNotificationItem();
    retired.number = 14;
    retired.disposition = 'retired';
    const prepared = approvedNotificationItem();
    prepared.number = 15;
    prepared.intake = { ...prepared.intake!, stage: 'prepared' };
    state.items[retiredKey] = retired;
    state.items[preparedKey] = prepared;

    assert.deepEqual(pendingGitHubNotificationItemKeys(state), [notificationItemKey, retiredKey]);
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
