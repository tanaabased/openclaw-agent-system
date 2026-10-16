import type {
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../channels/github/intake/monitor/state.ts';

import {
  notificationAccount,
  notificationActor,
  notificationOwner,
  notificationRepository,
} from './github-provider-fixtures.ts';

export const notificationItemKey = 'github:R_repo:12';
export const notificationPullRequestItemKey = 'github:R_repo:13';
export const notificationPullRequestHeadSha = 'a'.repeat(40);

export function approvedNotificationItem(): GitHubNotificationItemState {
  return {
    assignmentActorLogin: notificationActor.login,
    assignmentActorNodeId: notificationActor.nodeId,
    assignmentEventNodeId: 'EV_assignment',
    intake: {
      assignmentEventId: 'EV_assignment',
      scheduling: { sequence: 1, status: 'queued' },
      stage: 'admitted',
    },
    disposition: 'approved',
    itemDatabaseId: 7,
    itemNodeId: 'I_item',
    itemType: 'issue',
    lastObservedAt: 2,
    lifecycleId: 'issue',
    number: 12,
    reasonCode: 'assignment-approved',
    repositoryCloneUrl: notificationRepository.cloneUrl,
    repositoryDatabaseId: notificationRepository.databaseId,
    repositoryDefaultBranch: notificationRepository.defaultBranch,
    repositoryName: notificationRepository.name,
    repositoryNodeId: notificationRepository.nodeId,
    repositoryOwner: notificationOwner.login,
    repositoryOwnerNodeId: notificationOwner.nodeId,
    repositoryPermission: 'write',
  };
}

export function approvedPullRequestNotificationItem(): GitHubNotificationItemState {
  return {
    assignmentActorLogin: notificationActor.login,
    assignmentActorNodeId: notificationActor.nodeId,
    assignmentEventNodeId: 'EV_pull_request_assignment',
    intake: {
      assignmentEventId: 'EV_pull_request_assignment',
      stage: 'admitted',
    },
    disposition: 'approved',
    itemDatabaseId: 8,
    itemNodeId: 'PR_item',
    itemType: 'pull-request',
    lastObservedAt: 2,
    lifecycleId: 'pull-request',
    number: 13,
    pullRequest: {
      authorNodeId: notificationActor.nodeId,
      baseRef: 'main',
      draft: false,
      headRef: 'notification-pr',
      headRepositoryDatabaseId: notificationRepository.databaseId,
      headRepositoryNodeId: notificationRepository.nodeId,
      headSha: notificationPullRequestHeadSha,
    },
    reasonCode: 'assignment-approved',
    repositoryCloneUrl: notificationRepository.cloneUrl,
    repositoryDatabaseId: notificationRepository.databaseId,
    repositoryDefaultBranch: notificationRepository.defaultBranch,
    repositoryName: notificationRepository.name,
    repositoryNodeId: notificationRepository.nodeId,
    repositoryOwner: notificationOwner.login,
    repositoryOwnerNodeId: notificationOwner.nodeId,
    repositoryPermission: 'write',
  };
}

export function notificationMonitorState(): GitHubNotificationMonitorState {
  return {
    accountLogin: notificationAccount.login,
    accountNodeId: notificationAccount.nodeId,
    agentId: notificationAccount.login,
    baselineAt: 1,
    failureCount: 0,
    items: { [notificationItemKey]: approvedNotificationItem() },
    nextSchedulingSequence: 2,
    processedEventNodeIds: ['EV_assignment'],
    schemaVersion: 6,
    workspaceDir: '/workspace',
  };
}
