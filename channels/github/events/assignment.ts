import { githubNotificationMarkdownText } from '../conversation/presentation/card.ts';
import assignmentCard from '../conversation/presentation/assignment-card.ts';
import githubNotificationAssignmentEventInstructions from '../conversation/prompts/event-assignment.ts';
import githubNotificationAssignmentResponseInstructions from '../conversation/prompts/response-assignment.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';
import type { GitHubNotificationEvent } from './types.ts';

export interface GitHubNotificationAssignmentEventProjection {
  emoji: string;
  item: {
    kind: string;
    label: string;
    url: string;
  };
  sender: {
    id: string;
    label: string;
    url: string;
  };
  timestamp: number;
}

/** Render one lifecycle-projected assignment through the shared card grammar. */
export function githubNotificationAssignmentCard(
  projection: GitHubNotificationAssignmentEventProjection,
  modeId: GitHubNotificationModeId,
): string {
  const action =
    modeId === 'guided'
      ? 'The workspace is prepared; wait for operator direction'
      : 'Please begin working on it';
  return assignmentCard(
    projection,
    `${action} in \`${githubNotificationMarkdownText(modeId)}\` mode.`,
  );
}

/** Describe the registered assignment model event without scheduling it. */
const githubNotificationAssignmentEvent = {
  id: 'assignment',
  turn: {
    instructions: githubNotificationAssignmentEventInstructions,
    kind: 'model',
    publicationIntent: 'assignment-response',
    publicationSource: 'candidate',
    responseInstructions: githubNotificationAssignmentResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationAssignmentEvent;
