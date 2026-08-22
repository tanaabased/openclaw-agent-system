import type { GitHubNotificationLifecycleId } from '../lifecycles/types.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';

export const githubNotificationEventIds = ['assignment', 'comment'] as const;

export type GitHubNotificationEventId = (typeof githubNotificationEventIds)[number];

export interface GitHubNotificationTurnIdentity {
  eventId: GitHubNotificationEventId;
  lifecycleId: GitHubNotificationLifecycleId;
  modeId: GitHubNotificationModeId;
}
