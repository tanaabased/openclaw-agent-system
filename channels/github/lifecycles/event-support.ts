import type { GitHubNotificationEventId } from '../events/types.ts';
import type {
  GitHubNotificationLifecycle,
  GitHubNotificationLifecycleEventSupportMap,
} from './types.ts';

export class GitHubNotificationLifecycleEventSupportError extends Error {
  override name = 'GitHubNotificationLifecycleEventSupportError';

  constructor(readonly code: string) {
    super('The GitHub notification lifecycle does not support this event.');
  }
}

/** Inspect lifecycle-event support without starting or rejecting a turn. */
export function githubNotificationLifecycleSupportsEvent(
  lifecycle: GitHubNotificationLifecycle,
  eventId: GitHubNotificationEventId,
): boolean {
  return lifecycle.eventSupport[eventId] !== undefined;
}

/** Resolve one explicitly declared lifecycle-event pair or fail closed. */
export default function resolveGitHubNotificationLifecycleEventSupport<
  EventId extends GitHubNotificationEventId,
>(
  lifecycle: GitHubNotificationLifecycle,
  eventId: EventId,
): NonNullable<GitHubNotificationLifecycleEventSupportMap[EventId]> {
  const support = lifecycle.eventSupport[eventId];
  if (support === undefined) {
    throw new GitHubNotificationLifecycleEventSupportError(
      'github-notification-lifecycle-event-unsupported',
    );
  }
  return support as NonNullable<GitHubNotificationLifecycleEventSupportMap[EventId]>;
}
