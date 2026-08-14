import type { GitHubNotificationItemState } from './monitor-state.ts';

export type GitHubNotificationPresentationItem = Pick<
  GitHubNotificationItemState,
  'itemType' | 'number' | 'repositoryName' | 'repositoryOwner'
>;

function markdownLabel(value: string): string {
  return value
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\\[\]`*_]/gu, '\\$&');
}

export function githubNotificationActorLink(login: string): string {
  return `[@${markdownLabel(login)}](https://github.com/${encodeURIComponent(login)})`;
}

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
  return `[${markdownLabel(label)}](${githubNotificationItemUrl(item)})`;
}

export function githubNotificationCommentUrl(
  item: GitHubNotificationPresentationItem,
  commentDatabaseId: number,
): string {
  if (!Number.isSafeInteger(commentDatabaseId) || commentDatabaseId < 1) {
    throw new Error('GitHub comment database ids must be positive safe integers.');
  }
  return `${githubNotificationItemUrl(item)}#issuecomment-${commentDatabaseId}`;
}

export function githubNotificationCommentLink(
  item: GitHubNotificationPresentationItem,
  commentDatabaseId: number,
): string {
  const label = `${item.repositoryOwner}/${item.repositoryName}#${item.number}`;
  return `[${markdownLabel(label)}](${githubNotificationCommentUrl(item, commentDatabaseId)})`;
}

/** Format the shared assignment introduction for mode-specific private requests. */
export function githubNotificationAssignmentSentence(
  item: GitHubNotificationPresentationItem,
  title?: string,
): string {
  return `You've been assigned ${githubNotificationItemLink(item, title)}.`;
}

/** Format the mode-neutral assignment receipt that opens the private issue session. */
export default function githubNotificationAssignmentNotice(
  item: GitHubNotificationPresentationItem,
): string {
  return ['## 📥 Assignment received', '', githubNotificationAssignmentSentence(item)].join('\n');
}
