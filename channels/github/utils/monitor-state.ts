import type { GitHubRepositoryPermission } from './work-item.ts';
import type { GitHubNotificationLifecycleId } from '../lifecycles/types.ts';

export type GitHubNotificationItemDisposition = 'approved' | 'baseline' | 'rejected' | 'retired';

export type GitHubNotificationIntakeStage = 'admitted' | 'prepared' | 'retired';

export interface GitHubNotificationPullRequestState {
  authorNodeId?: string;
  baseRef: string;
  draft: boolean;
  headRef: string;
  headRepositoryDatabaseId?: number;
  headRepositoryNodeId?: string;
  headSha: string;
}

export interface GitHubNotificationIntakeState {
  assignmentEventId: string;
  failureCode?: string;
  stage: GitHubNotificationIntakeStage;
  worktreeBranch?: string;
  worktreePath?: string;
}

export interface GitHubNotificationItemState {
  assignmentActorLogin?: string;
  assignmentActorNodeId?: string;
  assignmentEventNodeId?: string;
  disposition: GitHubNotificationItemDisposition;
  intake?: GitHubNotificationIntakeState;
  itemDatabaseId: number;
  itemNodeId: string;
  itemType: 'issue' | 'pull-request';
  lastObservedAt: number;
  lifecycleId: GitHubNotificationLifecycleId;
  number: number;
  pullRequest?: GitHubNotificationPullRequestState;
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
  diagnosticCode?: string;
  failureCount: number;
  items: Record<string, GitHubNotificationItemState>;
  lastPollAt?: number;
  lastSuccessfulPollAt?: number;
  nextPollAt?: number;
  processedEventNodeIds: string[];
  schemaVersion: 4;
  searchBoundary?: string;
  workspaceDir: string;
}

export function createGitHubNotificationMonitorState(
  agentId: string,
  workspaceDir: string,
): GitHubNotificationMonitorState {
  return {
    agentId,
    failureCount: 0,
    items: {},
    processedEventNodeIds: [],
    schemaVersion: 4,
    workspaceDir,
  };
}

/** List intake records that still require local retirement. */
export function githubNotificationRetirementItemKeys(
  state: GitHubNotificationMonitorState | undefined,
): string[] {
  if (!state) return [];
  return Object.entries(state.items)
    .filter(([, item]) => item.intake !== undefined && item.intake.stage !== 'retired')
    .map(([itemKey]) => itemKey)
    .sort();
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
