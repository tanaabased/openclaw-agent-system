import type { GitHubRepositoryPermission } from './work-item.ts';
import type { GitHubNotificationExecutionMode } from '../messages/types.ts';

export type GitHubNotificationItemDisposition = 'approved' | 'baseline' | 'rejected' | 'retired';

export type GitHubNotificationDeliveryStage =
  'active' | 'admitted' | 'received' | 'retired' | 'session-recording' | 'worktree-ready';

export type GitHubNotificationAcknowledgmentState =
  | { failureCode: string; status: 'failed' }
  | { status: 'pending' }
  | { commentId: number; status: 'published' };

export interface GitHubNotificationActivationState {
  failureCode?: string;
  status: 'adopted' | 'failed' | 'ineligible' | 'pending' | 'planned';
}

export interface GitHubNotificationCommentTurnState {
  failureCode?: string;
  status: 'adopted' | 'failed' | 'pending' | 'responded';
}

export interface GitHubNotificationCommentRevisionState {
  actorNodeId?: string;
  bodyDigest: string;
  commentDatabaseId: number;
  commentNodeId: string;
  createdAt: number;
  disposition: 'approved' | 'baseline' | 'rejected';
  reasonCode: string;
  reply?: GitHubNotificationAcknowledgmentState;
  revisionId: string;
  turn?: GitHubNotificationCommentTurnState;
  updatedAt: number;
}

export interface GitHubNotificationCommentTrackingState {
  baselineAt?: number;
  diagnosticCode?: string;
  revisions: Record<string, GitHubNotificationCommentRevisionState>;
}

export interface GitHubNotificationPullRequestState {
  authorNodeId?: string;
  baseRef: string;
  draft: boolean;
  headRef: string;
  headRepositoryDatabaseId?: number;
  headRepositoryNodeId?: string;
  headSha: string;
}

export interface GitHubNotificationDeliveryState {
  activation?: GitHubNotificationActivationState;
  acknowledgment?: GitHubNotificationAcknowledgmentState;
  assignmentEventId: string;
  failureCode?: string;
  mode?: GitHubNotificationExecutionMode;
  progress?: Record<string, GitHubNotificationAcknowledgmentState>;
  schemaVersion: 1;
  sessionId?: string;
  sessionKey?: string;
  stage: GitHubNotificationDeliveryStage;
  workId: string;
  worktreeBranch?: string;
  worktreePath?: string;
}

export interface GitHubNotificationItemState {
  assignmentActorLogin?: string;
  assignmentActorNodeId?: string;
  assignmentEventNodeId?: string;
  commentTracking?: GitHubNotificationCommentTrackingState;
  delivery?: GitHubNotificationDeliveryState;
  disposition: GitHubNotificationItemDisposition;
  itemDatabaseId: number;
  itemNodeId: string;
  itemType: 'issue' | 'pull-request';
  lastObservedAt: number;
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
  schemaVersion: 3;
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
    schemaVersion: 3,
    workspaceDir,
  };
}

/** List delivery records that still require local retirement. */
export function githubNotificationRetirementItemKeys(
  state: GitHubNotificationMonitorState | undefined,
): string[] {
  if (!state) return [];
  return Object.entries(state.items)
    .filter(([, item]) => item.delivery !== undefined && item.delivery.stage !== 'retired')
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
