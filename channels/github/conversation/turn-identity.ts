import type { GitHubNotificationEventId } from '../events/types.ts';
import type { GitHubNotificationLifecycleId } from '../lifecycles/types.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';

export interface GitHubNotificationTurnIdentity {
  eventId: GitHubNotificationEventId;
  lifecycleId: GitHubNotificationLifecycleId;
  modeId: GitHubNotificationModeId;
}
