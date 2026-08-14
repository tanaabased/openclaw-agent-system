import type { GitHubNotificationItemState } from './monitor-state.ts';
import githubNotificationMessage, { githubNotificationMarkdownText } from './presentation.ts';

export type GitHubNotificationPresentationItem = Pick<
  GitHubNotificationItemState,
  'itemType' | 'number' | 'repositoryName' | 'repositoryOwner'
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

export function githubNotificationCommentLink(
  item: GitHubNotificationPresentationItem,
  commentDatabaseId: number,
): string {
  const reference = `${item.repositoryOwner}/${item.repositoryName}#${item.number}`;
  return `[${githubNotificationMarkdownText(reference)}](${githubNotificationCommentUrl(
    item,
    commentDatabaseId,
  )})`;
}

/** Format the shared assignment introduction for mode-specific private requests. */
export function githubNotificationAssignmentSentence(
  item: GitHubNotificationPresentationItem,
  title?: string,
): string {
  return `You've been assigned ${githubNotificationItemLink(item, title)}.`;
}

/** Format the mode-neutral assignment receipt that opens the private assignment session. */
export default function githubNotificationAssignmentNotice(
  item: GitHubNotificationPresentationItem,
): string {
  return githubNotificationMessage({
    emoji: '📥',
    summary: githubNotificationAssignmentSentence(item),
    title: 'Assignment received',
  });
}
