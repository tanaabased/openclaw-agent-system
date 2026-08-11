import type { GitHubRepositoryPermission } from './work-item.ts';

export type GitHubNotificationItemDisposition = 'approved' | 'baseline' | 'rejected' | 'retired';

export interface GitHubNotificationItemState {
  assignmentActorNodeId?: string;
  assignmentEventNodeId?: string;
  disposition: GitHubNotificationItemDisposition;
  itemNodeId: string;
  itemType: 'issue' | 'pull-request';
  lastObservedAt: number;
  number: number;
  reasonCode: string;
  repositoryDatabaseId: number;
  repositoryCloneUrl: string;
  repositoryDefaultBranch: string;
  repositoryName: string;
  repositoryNodeId: string;
  repositoryOwner: string;
  repositoryOwnerNodeId: string;
  repositoryPermission: GitHubRepositoryPermission;
}

export interface GitHubNotificationMonitorState {
  accountLogin?: string;
  accountNodeId?: string;
  agentId: string;
  baselineAt?: number;
  baselineItemNodeIds: string[];
  diagnosticCode?: string;
  failureCount: number;
  items: Record<string, GitHubNotificationItemState>;
  lastPollAt?: number;
  lastSuccessfulPollAt?: number;
  nextPollAt?: number;
  processedEventNodeIds: string[];
  schemaVersion: 1;
  searchBoundary?: string;
  workspaceDir: string;
}

export function createGitHubNotificationMonitorState(
  agentId: string,
  workspaceDir: string,
): GitHubNotificationMonitorState {
  return {
    agentId,
    baselineItemNodeIds: [],
    failureCount: 0,
    items: {},
    processedEventNodeIds: [],
    schemaVersion: 1,
    workspaceDir,
  };
}

export function rememberProcessedEvent(
  state: GitHubNotificationMonitorState,
  nodeId: string,
  maximum = 2_000,
): void {
  if (!nodeId || state.processedEventNodeIds.includes(nodeId)) return;
  state.processedEventNodeIds.push(nodeId);
  if (state.processedEventNodeIds.length > maximum) {
    state.processedEventNodeIds.splice(0, state.processedEventNodeIds.length - maximum);
  }
}
