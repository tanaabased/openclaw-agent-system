import { isDeepStrictEqual } from 'node:util';

import type {
  GitHubNotificationIntakeState,
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from './state.ts';

function changed(): never {
  throw Object.assign(new Error('The GitHub notification checkpoint belongs to stale state.'), {
    code: 'github-notification-state-checkpoint-stale',
  });
}

function sameScope(
  current: GitHubNotificationMonitorState | undefined,
  expected: GitHubNotificationMonitorState | undefined,
): boolean {
  return (
    current?.agentId === expected?.agentId &&
    current?.workspaceDir === expected?.workspaceDir &&
    current?.accountNodeId === expected?.accountNodeId &&
    current?.baselineAt === expected?.baselineAt
  );
}

function sameAssignment(
  current: GitHubNotificationItemState | undefined,
  expected: GitHubNotificationItemState | undefined,
): boolean {
  if (!current || !expected) return current === expected;
  return (
    current.itemNodeId === expected.itemNodeId &&
    current.itemDatabaseId === expected.itemDatabaseId &&
    current.repositoryNodeId === expected.repositoryNodeId &&
    current.repositoryDatabaseId === expected.repositoryDatabaseId &&
    current.lifecycleId === expected.lifecycleId &&
    current.assignmentEventNodeId === expected.assignmentEventNodeId &&
    current.intake?.assignmentEventId === expected.intake?.assignmentEventId
  );
}

export function assertGitHubNotificationAssignmentCheckpoint(
  current: GitHubNotificationMonitorState | undefined,
  expected: GitHubNotificationMonitorState,
  itemKey: string,
): asserts current is GitHubNotificationMonitorState {
  if (
    !current ||
    !sameScope(current, expected) ||
    !current.items[itemKey]?.intake ||
    !sameAssignment(current.items[itemKey], expected.items[itemKey])
  ) {
    changed();
  }
}

export type GitHubNotificationItemPatch = Partial<
  Pick<
    GitHubNotificationItemState,
    | 'disposition'
    | 'reasonCode'
    | 'repositoryCloneUrl'
    | 'repositoryDefaultBranch'
    | 'repositoryName'
    | 'repositoryOwner'
    | 'repositoryPermission'
  >
> & { intake?: Partial<Omit<GitHubNotificationIntakeState, 'assignmentEventId'>> };

/** Apply only one assignment's execution facts, retaining newer polling and retirement facts. */
export function patchGitHubNotificationItem(
  current: GitHubNotificationMonitorState | undefined,
  expected: GitHubNotificationMonitorState,
  itemKey: string,
  patch: GitHubNotificationItemPatch,
): GitHubNotificationMonitorState {
  assertGitHubNotificationAssignmentCheckpoint(current, expected, itemKey);
  const item = current.items[itemKey]!;
  const next = { ...item, ...patch, intake: { ...item.intake!, ...patch.intake } };
  if (next.intake.failureCode === undefined) delete next.intake.failureCode;
  if (item.disposition === 'retired') {
    next.disposition = item.disposition;
    next.reasonCode = item.reasonCode;
  }
  if (item.intake!.stage === 'retired') next.intake.stage = 'retired';
  if (item.intake!.providerRetirementVerifiedAt !== undefined) {
    next.intake.providerRetirementVerifiedAt = item.intake!.providerRetirementVerifiedAt;
  }
  return { ...current, items: { ...current.items, [itemKey]: next } };
}

/** Merge provider observations without replacing execution checkpoints made during the poll. */
export function checkpointGitHubNotificationPoll(
  current: GitHubNotificationMonitorState | undefined,
  previous: GitHubNotificationMonitorState | undefined,
  polled: GitHubNotificationMonitorState,
): GitHubNotificationMonitorState {
  if (!sameScope(current, previous)) changed();
  if (!current || current.accountNodeId !== polled.accountNodeId) return polled;
  const items = { ...current.items };
  for (const [key, observed] of Object.entries(polled.items)) {
    const before = previous?.items[key];
    if (isDeepStrictEqual(before, observed)) continue;
    const latest = current.items[key];
    if (!sameAssignment(latest, before)) changed();
    if (!sameAssignment(observed, before) || !latest?.intake) {
      items[key] = observed;
      continue;
    }
    items[key] = {
      ...observed,
      ...(latest.disposition === 'retired' && observed.disposition !== 'retired'
        ? { disposition: latest.disposition, reasonCode: latest.reasonCode }
        : {}),
      intake: {
        ...latest.intake,
        ...(observed.intake?.stage === 'retired'
          ? {
              stage: 'retired',
              providerRetirementVerifiedAt:
                latest.intake.providerRetirementVerifiedAt ??
                observed.intake.providerRetirementVerifiedAt,
            }
          : {}),
      },
    };
  }
  return { ...polled, items };
}
