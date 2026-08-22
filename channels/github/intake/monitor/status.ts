import type {
  GitHubNotificationIntakeStage,
  GitHubNotificationItemDisposition,
  GitHubNotificationMonitorState,
} from './state.ts';
import {
  githubNotificationItemMatchesSelector,
  type GitHubNotificationItemSelector,
} from '../../provider/work-item.ts';

export type { GitHubNotificationItemSelector } from '../../provider/work-item.ts';

export type GitHubNotificationWaitTarget =
  'assignment-rejected' | 'baseline-ready' | 'prepared' | 'retired' | 'worktree-ready';

export const githubNotificationWaitTargets = new Set<GitHubNotificationWaitTarget>([
  'assignment-rejected',
  'baseline-ready',
  'prepared',
  'retired',
  'worktree-ready',
]);

export interface GitHubNotificationStatusItem {
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
  stage?: GitHubNotificationIntakeStage;
  worktree: 'not-applicable' | 'pending' | 'ready';
}

export interface GitHubNotificationStatusResult {
  agentId: string;
  baseline: { observedAt?: number; status: 'pending' | 'ready' };
  code: string;
  diagnosticCode?: string;
  items: GitHubNotificationStatusItem[];
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

/** Project private monitor state into a value-free operator and test surface. */
export function githubNotificationMonitorStatus(
  agentId: string,
  state: GitHubNotificationMonitorState | undefined,
  selector?: GitHubNotificationItemSelector,
): GitHubNotificationStatusResult {
  if (!state) {
    return {
      agentId,
      baseline: { status: 'pending' },
      code: 'github-notification-status-pending',
      items: [],
      schemaVersion: 2,
      status: 'pending',
    };
  }

  const items = Object.values(state.items)
    .map((item): GitHubNotificationStatusItem => {
      const intake = item.intake;
      return {
        disposition: item.disposition,
        ...(intake?.failureCode === undefined ? {} : { failureCode: intake.failureCode }),
        itemType: item.itemType,
        lifecycleId: item.lifecycleId,
        number: item.number,
        ...(item.pullRequest === undefined
          ? {}
          : {
              pullRequest: {
                baseRef: item.pullRequest.baseRef,
                draft: item.pullRequest.draft,
                headRef: item.pullRequest.headRef,
                headSha: item.pullRequest.headSha,
              },
            }),
        reasonCode: item.reasonCode,
        repository: `${item.repositoryOwner}/${item.repositoryName}`,
        ...(intake?.stage === undefined ? {} : { stage: intake.stage }),
        worktree:
          item.itemType === 'pull-request'
            ? 'not-applicable'
            : intake?.worktreeBranch && intake.worktreePath
              ? 'ready'
              : 'pending',
      };
    })
    .filter((item) => selector === undefined || matchesSelector(item, selector))
    .sort(
      (left, right) =>
        left.repository.localeCompare(right.repository) ||
        left.number - right.number ||
        left.itemType.localeCompare(right.itemType),
    );
  const pending = state.baselineAt === undefined || state.lastSuccessfulPollAt === undefined;
  return {
    agentId,
    baseline: {
      ...(state.baselineAt === undefined ? {} : { observedAt: state.baselineAt }),
      status: state.baselineAt === undefined ? 'pending' : 'ready',
    },
    code: state.diagnosticCode
      ? state.diagnosticCode
      : pending
        ? 'github-notification-status-pending'
        : 'github-notification-status-ready',
    ...(state.diagnosticCode === undefined ? {} : { diagnosticCode: state.diagnosticCode }),
    items,
    schemaVersion: 2,
    status: state.diagnosticCode ? 'degraded' : pending ? 'pending' : 'ready',
  };
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
        : target === 'prepared'
          ? item.stage === 'prepared'
          : item.worktree === 'ready' && ['prepared', 'retired'].includes(item.stage ?? '');
  return reached
    ? { code: `github-notification-${target}`, status: 'reached' }
    : { code: 'github-notification-wait-pending', status: 'pending' };
}
