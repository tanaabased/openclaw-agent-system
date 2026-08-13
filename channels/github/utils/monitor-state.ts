import type { GitHubRepositoryPermission } from './work-item.ts';

export type GitHubNotificationItemDisposition = 'approved' | 'baseline' | 'rejected' | 'retired';

export type GitHubNotificationDeliveryStage =
  'active' | 'admitted' | 'retired' | 'session-recording' | 'worktree-ready';

export type GitHubNotificationAcknowledgmentState =
  { status: 'pending' } | { commentId: number; status: 'published' };

export interface GitHubNotificationDeliveryState {
  acknowledgment?: GitHubNotificationAcknowledgmentState;
  assignmentEventId: string;
  failureCode?: string;
  schemaVersion: 1;
  sessionId?: string;
  sessionKey?: string;
  stage: GitHubNotificationDeliveryStage;
  workId: string;
  worktreeBranch?: string;
  worktreePath?: string;
}

export interface GitHubNotificationItemState {
  assignmentActorNodeId?: string;
  assignmentEventNodeId?: string;
  delivery?: GitHubNotificationDeliveryState;
  disposition: GitHubNotificationItemDisposition;
  itemDatabaseId: number;
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
  schemaVersion: 2;
  searchBoundary?: string;
  workspaceDir: string;
}

export type GitHubNotificationItemStateV1 = Omit<
  GitHubNotificationItemState,
  'delivery' | 'itemDatabaseId'
>;

export type GitHubNotificationMonitorStateV1 = Omit<
  GitHubNotificationMonitorState,
  'items' | 'schemaVersion'
> & {
  items: Record<string, GitHubNotificationItemStateV1>;
  schemaVersion: 1;
};

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
    schemaVersion: 2,
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

/** Establish a safe baseline instead of retroactively delivering Phase 1 admissions. */
export function migrateGitHubNotificationMonitorStateV1(
  state: GitHubNotificationMonitorStateV1,
): GitHubNotificationMonitorState {
  const baselineItemNodeIds = [
    ...state.baselineItemNodeIds,
    ...Object.values(state.items).map(({ itemNodeId }) => itemNodeId),
  ];
  return {
    ...state,
    baselineItemNodeIds: [...new Set(baselineItemNodeIds)].slice(-2_000),
    diagnosticCode: 'github-notification-state-migrated-v1',
    items: {},
    schemaVersion: 2,
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
