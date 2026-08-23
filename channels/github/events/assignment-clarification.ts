import githubNotificationAssignmentClarificationEventInstructions from '../conversation/prompts/event-assignment-clarification.ts';
import githubNotificationPlanningResponseInstructions from '../conversation/prompts/response-planning.ts';
import type { GitHubNotificationEvent } from './types.ts';

/** Describe an admitted answer that resumes assignment planning. */
const githubNotificationAssignmentClarificationEvent = {
  id: 'assignment-clarification',
  turn: {
    instructions: githubNotificationAssignmentClarificationEventInstructions,
    kind: 'model',
    publicationIntent: 'planning-outcome',
    responseInstructions: githubNotificationPlanningResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationAssignmentClarificationEvent;
