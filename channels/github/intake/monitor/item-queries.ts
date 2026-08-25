import {
  githubNotificationItemMatchesSelector,
  type GitHubNotificationItemSelector,
} from '../../provider/work-item.ts';
import type { GitHubNotificationMonitorState } from './state.ts';

function matchesSelector(
  item: GitHubNotificationMonitorState['items'][string],
  selector: GitHubNotificationItemSelector,
): boolean {
  return githubNotificationItemMatchesSelector(
    item,
    `${item.repositoryOwner}/${item.repositoryName}`,
    selector,
  );
}

export function pendingGitHubNotificationItemKeys(
  state: GitHubNotificationMonitorState | undefined,
  selector?: GitHubNotificationItemSelector,
): string[] {
  if (!state) return [];
  return Object.entries(state.items)
    .filter(
      ([, item]) =>
        (selector === undefined || matchesSelector(item, selector)) &&
        item.intake !== undefined &&
        ((item.disposition === 'approved' && item.intake.stage === 'admitted') ||
          (item.disposition === 'retired' && item.intake.stage !== 'retired')),
    )
    .map(([itemKey]) => itemKey)
    .sort();
}

export function preparedGitHubNotificationIssueItemKeys(
  state: GitHubNotificationMonitorState | undefined,
  selector?: GitHubNotificationItemSelector,
): string[] {
  if (!state) return [];
  return Object.entries(state.items)
    .filter(
      ([, item]) =>
        (selector === undefined || matchesSelector(item, selector)) &&
        item.disposition === 'approved' &&
        item.lifecycleId === 'issue' &&
        item.intake?.stage === 'prepared',
    )
    .map(([itemKey]) => itemKey)
    .sort();
}
