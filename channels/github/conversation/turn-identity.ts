import type { GitHubNotificationLifecycleId } from '../lifecycles/types.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';
import type { GitHubNotificationEventId } from '../events/types.ts';

export { githubNotificationEventIds } from '../events/types.ts';
export type { GitHubNotificationEventId } from '../events/types.ts';

export interface GitHubNotificationTurnIdentity {
  eventId: GitHubNotificationEventId;
  lifecycleId: GitHubNotificationLifecycleId;
  modeId: GitHubNotificationModeId;
}
