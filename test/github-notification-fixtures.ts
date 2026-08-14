import type {
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../channels/github/utils/monitor-state.ts';

export const notificationAccount = { login: 'tanaabot', nodeId: 'U_agent', type: 'User' };
export const notificationActor = { login: 'pirog', nodeId: 'U_actor', type: 'User' };
export const notificationOwner = {
  login: 'tanaabased',
  nodeId: 'O_owner',
  type: 'Organization',
};
export const notificationRepository = {
  archived: false,
  cloneUrl: 'https://github.com/tanaabased/example.git',
  databaseId: 3,
  defaultBranch: 'main',
  disabled: false,
  name: 'example',
  nodeId: 'R_repo',
  owner: notificationOwner,
};
export const notificationItemKey = 'github:R_repo:12';
export const notificationPullRequestItemKey = 'github:R_repo:13';
export const notificationPullRequestHeadSha = 'a'.repeat(40);

export function approvedNotificationItem(): GitHubNotificationItemState {
  return {
    assignmentActorNodeId: notificationActor.nodeId,
    assignmentEventNodeId: 'EV_assignment',
    delivery: {
      assignmentEventId: 'EV_assignment',
      schemaVersion: 1,
      stage: 'admitted',
      workId: 'issue-7',
    },
    disposition: 'approved',
    itemDatabaseId: 7,
    itemNodeId: 'I_item',
    itemType: 'issue',
    lastObservedAt: 2,
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
    assignmentActorNodeId: notificationActor.nodeId,
    assignmentEventNodeId: 'EV_pull_request_assignment',
    delivery: {
      assignmentEventId: 'EV_pull_request_assignment',
      schemaVersion: 1,
      stage: 'admitted',
      workId: 'pull-request-8',
    },
    disposition: 'approved',
    itemDatabaseId: 8,
    itemNodeId: 'PR_item',
    itemType: 'pull-request',
    lastObservedAt: 2,
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
    processedEventNodeIds: ['EV_assignment'],
    schemaVersion: 3,
    workspaceDir: '/workspace',
  };
}
