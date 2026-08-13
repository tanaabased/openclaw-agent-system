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

export function notificationMonitorState(): GitHubNotificationMonitorState {
  return {
    accountLogin: notificationAccount.login,
    accountNodeId: notificationAccount.nodeId,
    agentId: notificationAccount.login,
    baselineAt: 1,
    baselineItemNodeIds: [],
    failureCount: 0,
    items: { [notificationItemKey]: approvedNotificationItem() },
    processedEventNodeIds: ['EV_assignment'],
    schemaVersion: 2,
    workspaceDir: '/workspace',
  };
}

export function legacyNotificationMonitorState(): Record<string, unknown> {
  const item: Record<string, unknown> = { ...approvedNotificationItem() };
  delete item.delivery;
  delete item.itemDatabaseId;
  return {
    ...notificationMonitorState(),
    items: { [notificationItemKey]: item },
    schemaVersion: 1,
  };
}
