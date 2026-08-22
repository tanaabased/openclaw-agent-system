import githubNotificationCommentEventInstructions from '../conversation/prompts/event-comment.ts';
import githubNotificationResponseInstructions from '../conversation/prompts/response.ts';
import type { GitHubNotificationEvent } from './types.ts';

/** Describe the currently model-backed comment event. */
const githubNotificationCommentEvent = {
  id: 'comment',
  turn: {
    instructions: githubNotificationCommentEventInstructions,
    kind: 'model',
    responseInstructions: githubNotificationResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationCommentEvent;
