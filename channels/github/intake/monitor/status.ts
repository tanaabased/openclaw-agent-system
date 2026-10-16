import type { GitHubNotificationMonitorState } from './state.ts';
import {
  githubNotificationItemMatchesSelector,
  type GitHubNotificationItemSelector,
} from '../../provider/work-item.ts';
import type {
  GitHubNotificationStatusItem,
  GitHubNotificationStatusResult,
} from '../../cli/contracts.ts';

/** Project private monitor state into a value-free operator and test surface. */
export function githubNotificationMonitorStatus(
  agentId: string,
  state: GitHubNotificationMonitorState | undefined,
  selector?: GitHubNotificationItemSelector,
  maximumConcurrentIssues = 2,
): GitHubNotificationStatusResult {
  if (!state) {
    return {
      agentId,
      baseline: { status: 'pending' },
      capacity: { active: 0, limit: maximumConcurrentIssues, queued: 0 },
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
        ...(intake?.cleanup === undefined ? {} : { cleanup: intake.cleanup }),
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
        ...(intake?.scheduling === undefined ? {} : { scheduling: intake.scheduling.status }),
        ...(intake?.stage === undefined ? {} : { stage: intake.stage }),
        ...(intake?.scheduling?.status === 'waiting' && intake.scheduling.reasonCode
          ? { waitingReason: intake.scheduling.reasonCode }
          : {}),
        worktree:
          item.itemType === 'pull-request'
            ? 'not-applicable'
            : intake?.worktreeBranch && intake.worktreePath
              ? 'ready'
              : 'pending',
      };
    })
    .filter(
      (item) =>
        selector === undefined ||
        githubNotificationItemMatchesSelector(item, item.repository, selector),
    )
    .sort(
      (left, right) =>
        left.repository.localeCompare(right.repository) ||
        left.number - right.number ||
        left.itemType.localeCompare(right.itemType),
    );
  const pending = state.baselineAt === undefined || state.lastSuccessfulPollAt === undefined;
  const itemFailures = (state.itemFailures ?? []).filter(
    (failure) =>
      selector === undefined ||
      (failure.repository.toLowerCase() === selector.repository.toLowerCase() &&
        failure.number === selector.number &&
        failure.itemType === selector.itemType),
  );
  const scheduling = Object.values(state.items)
    .filter(
      (item) =>
        item.disposition === 'approved' &&
        item.lifecycleId === 'issue' &&
        item.intake?.stage !== 'retired',
    )
    .map((item) => item.intake?.scheduling)
    .filter((value) => value !== undefined);
  return {
    agentId,
    baseline: {
      ...(state.baselineAt === undefined ? {} : { observedAt: state.baselineAt }),
      status: state.baselineAt === undefined ? 'pending' : 'ready',
    },
    capacity: {
      active: scheduling.filter(({ status }) => status === 'active').length,
      limit: maximumConcurrentIssues,
      queued: scheduling.filter(({ status }) => status === 'queued').length,
    },
    code: state.diagnosticCode
      ? state.diagnosticCode
      : itemFailures.length
        ? 'github-notification-item-permission-denied'
        : pending
          ? 'github-notification-status-pending'
          : 'github-notification-status-ready',
    ...(state.diagnosticCode === undefined ? {} : { diagnosticCode: state.diagnosticCode }),
    ...(itemFailures.length ? { itemFailures } : {}),
    items,
    schemaVersion: 2,
    status:
      state.diagnosticCode || itemFailures.length ? 'degraded' : pending ? 'pending' : 'ready',
  };
}
