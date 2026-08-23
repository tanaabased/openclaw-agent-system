import githubNotificationCommentEventInstructions from '../conversation/prompts/event-comment.ts';
import githubNotificationResponseInstructions from '../conversation/prompts/response.ts';
import type { GitHubNotificationEvent } from './types.ts';

/** Present one admitted GitHub comment without changing its author-written text. */
export function githubNotificationCommentPresentation(body: string): string {
  return body;
}

/** Describe the currently model-backed comment event. */
const githubNotificationCommentEvent = {
  id: 'comment',
  turn: {
    instructions: githubNotificationCommentEventInstructions,
    kind: 'model',
    publicationIntent: 'github-reply',
    responseInstructions: githubNotificationResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationCommentEvent;
