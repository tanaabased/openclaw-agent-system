import githubNotificationCard, {
  githubNotificationMarkdownText,
} from '../conversation/presentation/card.ts';
import githubNotificationAssignmentEventInstructions from '../conversation/prompts/event-assignment.ts';
import githubNotificationAssignmentResponseInstructions from '../conversation/prompts/response-assignment.ts';
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
  modeId: string,
): string {
  return githubNotificationCard({
    emoji: projection.emoji,
    summary: `[@${githubNotificationMarkdownText(projection.sender.label)}](${projection.sender.url}) assigned you to [${githubNotificationMarkdownText(projection.item.label)}](${projection.item.url}). Please begin working on it in \`${githubNotificationMarkdownText(modeId)}\` mode.`,
    title: `${projection.item.kind} assigned`,
  });
}

/** Describe the registered assignment model event without scheduling it. */
const githubNotificationAssignmentEvent = {
  id: 'assignment',
  turn: {
    instructions: githubNotificationAssignmentEventInstructions,
    kind: 'model',
    publicationIntent: 'assignment-response',
    responseInstructions: githubNotificationAssignmentResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationAssignmentEvent;
