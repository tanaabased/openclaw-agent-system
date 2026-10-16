import {
  githubNotificationItemMatchesSelector,
  type GitHubNotificationItemSelector,
} from '../provider/work-item.ts';

export type GitHubNotificationItemDisposition = 'approved' | 'baseline' | 'rejected' | 'retired';

export type GitHubNotificationIntakeStage = 'admitted' | 'prepared' | 'retired';

export type GitHubNotificationCleanupStatus = 'completed' | 'failed' | 'skipped';

export interface GitHubNotificationCleanupState {
  reasonCode: string;
  session: 'archived' | 'failed' | 'missing' | 'pinned';
  status: GitHubNotificationCleanupStatus;
  worktree: 'dirty' | 'failed' | 'missing' | 'not-applicable' | 'removed' | 'unsafe';
}

export interface GitHubNotificationItemFailure {
  cause: 'repository-permission-denied';
  itemType: 'issue' | 'pull-request';
  number: number;
  repository: string;
  stage: 'permission-check';
  updatedAt?: string;
}

export type { GitHubNotificationItemSelector } from '../provider/work-item.ts';

export type GitHubNotificationWaitTarget =
  | 'assignment-rejected'
  | 'baseline-ready'
  | 'plan-ready'
  | 'prepared'
  | 'retired'
  | 'worktree-ready';

export const githubNotificationWaitTargets = new Set<GitHubNotificationWaitTarget>([
  'assignment-rejected',
  'baseline-ready',
  'plan-ready',
  'prepared',
  'retired',
  'worktree-ready',
]);

export interface GitHubNotificationStatusItem {
  workflow?: { phase: string; conversation?: string };
  cleanup?: GitHubNotificationCleanupState;
  disposition: GitHubNotificationItemDisposition;
  failureCode?: string;
  itemType: 'issue' | 'pull-request';
  lifecycleId: 'issue' | 'pull-request' | 'pull-request-review';
  number: number;
  pullRequest?: {
    baseRef: string;
    draft: boolean;
    headRef: string;
    headSha: string;
  };
  reasonCode: string;
  repository: string;
  scheduling?: 'active' | 'queued' | 'waiting';
  stage?: GitHubNotificationIntakeStage;
  waitingReason?: string;
  worktree: 'not-applicable' | 'pending' | 'ready';
}

export interface GitHubNotificationStatusResult {
  scan?: { completedAt?: number; attemptedAt?: number };
  agentId: string;
  baseline: { observedAt?: number; status: 'pending' | 'ready' };
  capacity: { active: number; limit: number; queued: number };
  code: string;
  diagnosticCode?: string;
  items: GitHubNotificationStatusItem[];
  itemFailures?: GitHubNotificationItemFailure[];
  schemaVersion: 2;
  status: 'degraded' | 'pending' | 'ready';
}

export interface GitHubNotificationWaitObservation {
  code: string;
  status: 'failed' | 'pending' | 'reached';
}

function matchesSelector(
  item: GitHubNotificationStatusItem,
  selector: GitHubNotificationItemSelector,
): boolean {
  return githubNotificationItemMatchesSelector(item, item.repository, selector);
}

/** Evaluate one intake checkpoint without parsing chat presentation or provider prose. */
export function evaluateGitHubNotificationWait(
  result: GitHubNotificationStatusResult,
  target: GitHubNotificationWaitTarget,
  selector?: GitHubNotificationItemSelector,
): GitHubNotificationWaitObservation {
  if (result.diagnosticCode) return { code: result.diagnosticCode, status: 'failed' };
  if (target === 'baseline-ready') {
    return result.baseline.status === 'ready'
      ? { code: 'github-notification-baseline-ready', status: 'reached' }
      : { code: 'github-notification-wait-pending', status: 'pending' };
  }
  if (selector && result.itemFailures?.length)
    return {
      code: 'github-notification-item-permission-denied',
      status: 'failed',
    };
  const item = selector
    ? result.items.find((candidate) => matchesSelector(candidate, selector))
    : undefined;
  if (!item) return { code: 'github-notification-wait-pending', status: 'pending' };
  if (item.failureCode) return { code: item.failureCode, status: 'failed' };

  const reached =
    target === 'assignment-rejected'
      ? item.disposition === 'rejected'
      : target === 'retired'
        ? item.stage === 'retired'
        : target === 'plan-ready'
          ? item.workflow?.phase === 'plan-ready'
          : target === 'prepared'
            ? item.stage === 'prepared'
            : item.worktree === 'ready' && ['prepared', 'retired'].includes(item.stage ?? '');
  return reached
    ? { code: `github-notification-${target}`, status: 'reached' }
    : { code: 'github-notification-wait-pending', status: 'pending' };
}

export interface GitHubNotificationRefreshResult {
  agentId: string;
  approved?: number;
  baseline?: number;
  baselineAt?: number;
  baselineEstablished?: boolean;
  code: string;
  diagnosticCode?: string;
  duplicates?: number;
  itemFailures?: GitHubNotificationItemFailure[];
  lastSuccessfulPollAt?: number;
  nextPollAt?: number;
  rejected?: number;
  retryAt?: number;
  retired?: number;
  status: 'completed' | 'failed' | 'queued' | 'skipped';
  runId?: string;
}

export interface GitHubNotificationWaitResult {
  agentId: string;
  code: string;
  observation: GitHubNotificationStatusResult;
  schemaVersion: 2;
  status: 'completed' | 'failed' | 'timed-out';
  target: GitHubNotificationWaitTarget;
}
