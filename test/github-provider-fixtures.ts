import type { GitHubNotificationPublicationItem } from '../channels/github/publication/publication-contract.ts';

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

export function publicationItem(): GitHubNotificationPublicationItem {
  return {
    lifecycleId: 'issue',
    number: 12,
    repositoryName: notificationRepository.name,
    repositoryNodeId: notificationRepository.nodeId,
    repositoryOwner: notificationOwner.login,
  };
}
