import type { SharedDispatchRecord } from '../dispatch/dispatch-state.ts';
import type { ManagedIssue } from '../managed-issue.ts';
import type { GitHubNotificationIntakeClient } from '../../../channels/github/provider/work-event-types.ts';
import { replyLocator } from '../feedback/reply-target.ts';

type Link = { pullRequestNodeId: string; pullRequestNumber: number };

/** Explicit association edits override historical delivery receipts without rewriting them. */
export default function taskPullRequest(
  record: Pick<SharedDispatchRecord, 'pullRequestLink'> & {
    delivery?: { pullRequest?: Link };
  },
) {
  return record.pullRequestLink !== undefined
    ? (record.pullRequestLink ?? undefined)
    : record.delivery?.pullRequest;
}

export function isCurrentTaskPullRequest(
  record: Parameters<typeof taskPullRequest>[0],
  intake: Pick<ManagedIssue, 'repository'>,
  target: string | null | undefined,
) {
  const current = taskPullRequest(record);
  return Boolean(
    current &&
    target ===
      `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/pull/${current.pullRequestNumber}`,
  );
}

export async function setTaskPullRequestLink(
  record: Pick<SharedDispatchRecord, 'pullRequestLink'>,
  intake: ManagedIssue,
  target: string | null,
  provider: Pick<GitHubNotificationIntakeClient, 'getRepository' | 'getItem'>,
) {
  if (target === null) {
    record.pullRequestLink = null;
    return;
  }
  const locator = replyLocator(target);
  if (locator.itemType !== 'pull-request' || locator.kind)
    throw new Error('delivery-link-target-invalid');
  const repository = await provider.getRepository(locator.owner, locator.name);
  const item = await provider.getItem(locator.owner, locator.name, locator.number);
  if (
    repository.nodeId !== intake.repository.nodeId ||
    item.itemType !== 'pull-request' ||
    item.pullRequest.baseRepositoryNodeId !== repository.nodeId
  )
    throw new Error('delivery-link-target-invalid');
  record.pullRequestLink = { pullRequestNodeId: item.nodeId, pullRequestNumber: item.number };
}
