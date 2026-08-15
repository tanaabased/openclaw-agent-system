import type { GitHubNotificationItemState } from '../../utils/monitor-state.ts';
import type { GitHubNotificationExecutionMode } from '../types.ts';
import githubNotificationCard, { githubNotificationMarkdownText } from './card.ts';

export type GitHubNotificationPresentationItem = Pick<
  GitHubNotificationItemState,
  'assignmentActorLogin' | 'itemType' | 'number' | 'repositoryName' | 'repositoryOwner'
>;

export function githubNotificationItemUrl(item: GitHubNotificationPresentationItem): string {
  const collection = item.itemType === 'pull-request' ? 'pull' : 'issues';
  return `https://github.com/${encodeURIComponent(item.repositoryOwner)}/${encodeURIComponent(item.repositoryName)}/${collection}/${item.number}`;
}

export function githubNotificationItemLink(
  item: GitHubNotificationPresentationItem,
  title?: string,
): string {
  const reference = `${item.repositoryOwner}/${item.repositoryName}#${item.number}`;
  const label = title?.trim() ? `${reference} — ${title}` : reference;
  return `[${githubNotificationMarkdownText(label)}](${githubNotificationItemUrl(item)})`;
}

export function githubNotificationCommentUrl(
  item: GitHubNotificationPresentationItem,
  commentDatabaseId: number,
): string {
  if (!Number.isSafeInteger(commentDatabaseId) || commentDatabaseId < 1) {
    throw new Error('GitHub notification comment ids must be positive safe integers.');
  }
  return `${githubNotificationItemUrl(item)}#issuecomment-${commentDatabaseId}`;
}

function actorLink(login: string | undefined): string {
  if (!login) return 'An approved GitHub actor';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(login)) {
    throw new Error('GitHub notification assignment actor logins are invalid.');
  }
  return `[@${login}](https://github.com/${encodeURIComponent(login)})`;
}

function modeDescription(
  itemType: GitHubNotificationPresentationItem['itemType'],
  mode: GitHubNotificationExecutionMode,
): string {
  if (mode !== 'plan') {
    throw new Error(`GitHub notification ${mode} presentation is not implemented.`);
  }
  return itemType === 'issue'
    ? 'Plan — investigate the issue and prepare an implementation plan.'
    : 'Plan — assess the pull request and prepare a recommended course of action.';
}

/** Render the visible assignment card without provider context or instructions. */
export default function githubNotificationAssignmentCard(input: {
  item: GitHubNotificationPresentationItem;
  mode: GitHubNotificationExecutionMode;
  title?: string;
}): string {
  const kind = input.item.itemType === 'issue' ? 'Issue' : 'Pull request';
  return githubNotificationCard({
    emoji: input.item.itemType === 'issue' ? '📥' : '🔀',
    mode: modeDescription(input.item.itemType, input.mode),
    summary: `${actorLink(input.item.assignmentActorLogin)} assigned you ${githubNotificationItemLink(
      input.item,
      input.title,
    )}.`,
    title: `${kind} assignment received`,
  });
}
