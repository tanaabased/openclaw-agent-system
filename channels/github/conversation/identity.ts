import type { GitHubNotificationAssignmentEvent } from '../channel.ts';

/** retain the same conversation identity across runtime adapters. */
export function githubNotificationConversationId(
  event: Pick<GitHubNotificationAssignmentEvent, 'itemNumber' | 'lifecycleId' | 'repositoryId'>,
): string {
  if (!Number.isSafeInteger(event.itemNumber) || event.itemNumber < 1) {
    throw new Error('GitHub notification item numbers must be positive safe integers.');
  }
  if (!['issue', 'pull-request', 'pull-request-review'].includes(event.lifecycleId)) {
    throw new Error('GitHub notification lifecycle ids are invalid.');
  }
  const repositoryId = event.repositoryId.trim();
  if (!repositoryId) throw new Error('GitHub notification repository ids must not be empty.');
  return `github:${event.lifecycleId}:${encodeURIComponent(repositoryId)}:${event.itemNumber}`;
}
