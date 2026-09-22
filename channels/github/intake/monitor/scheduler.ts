import {
  githubNotificationItemMatchesSelector,
  type GitHubNotificationItemSelector,
} from '../../provider/work-item.ts';
import type {
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
  GitHubNotificationSchedulingState,
} from './state.ts';

function matchesSelector(
  item: GitHubNotificationItemState,
  selector: GitHubNotificationItemSelector | undefined,
): boolean {
  return (
    selector === undefined ||
    githubNotificationItemMatchesSelector(
      item,
      `${item.repositoryOwner}/${item.repositoryName}`,
      selector,
    )
  );
}

function schedulableIssue(
  item: GitHubNotificationItemState | undefined,
): item is GitHubNotificationItemState {
  return (
    item !== undefined &&
    item.disposition === 'approved' &&
    item.lifecycleId === 'issue' &&
    item.intake !== undefined &&
    item.intake.stage !== 'retired' &&
    item.intake.scheduling !== undefined
  );
}

function orderedEntries(state: GitHubNotificationMonitorState) {
  return Object.entries(state.items)
    .filter(([, item]) => schedulableIssue(item))
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        left.intake!.scheduling!.sequence - right.intake!.scheduling!.sequence ||
        leftKey.localeCompare(rightKey),
    );
}

/** Claim available per-agent issue capacity from the latest durable monitor state. */
export function claimGitHubNotificationIssueWork(
  current: GitHubNotificationMonitorState | undefined,
  maximum: number,
  selector?: GitHubNotificationItemSelector,
): { itemKeys: string[]; state: GitHubNotificationMonitorState } {
  if (!current) throw new Error('The GitHub notification monitor state is missing.');
  const state = structuredClone(current);
  const entries = orderedEntries(state);
  const active = entries.filter(([, item]) => item.intake!.scheduling!.status === 'active');
  const available = Math.max(0, maximum - active.length);
  const selected = active
    .filter(([, item]) => matchesSelector(item, selector))
    .map(([itemKey]) => itemKey);

  const eligible = entries
    .filter(([, item]) => item.intake!.scheduling!.status === 'queued')
    .slice(0, available);
  for (const [itemKey, item] of eligible) {
    const scheduling = item.intake!.scheduling!;
    if (!matchesSelector(item, selector)) continue;
    item.intake!.scheduling = { sequence: scheduling.sequence, status: 'active' };
    selected.push(itemKey);
  }
  return { itemKeys: selected, state };
}

/** Move one issue to the tail of the durable queue. */
export function queueGitHubNotificationIssueWork(
  state: GitHubNotificationMonitorState,
  itemKey: string,
  reasonCode?: string,
): void {
  const item = state.items[itemKey];
  if (!schedulableIssue(item)) return;
  item.intake!.scheduling = {
    ...(reasonCode === undefined ? {} : { reasonCode }),
    sequence: state.nextSchedulingSequence,
    status: 'queued',
  };
  state.nextSchedulingSequence += 1;
}

/** Release one issue slot until a later poll or follow-up makes it eligible again. */
export function waitGitHubNotificationIssueWork(
  state: GitHubNotificationMonitorState,
  itemKey: string,
  reasonCode: string,
): void {
  const item = state.items[itemKey];
  if (!schedulableIssue(item)) return;
  const scheduling: GitHubNotificationSchedulingState = {
    reasonCode,
    sequence: item.intake!.scheduling!.sequence,
    status: 'waiting',
  };
  item.intake!.scheduling = scheduling;
}
