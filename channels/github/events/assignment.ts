import type { GitHubNotificationEvent } from './types.ts';

/** Describe the currently observe-only assignment event. */
const githubNotificationAssignmentEvent = {
  id: 'assignment',
  turn: { kind: 'observe-only' },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationAssignmentEvent;
