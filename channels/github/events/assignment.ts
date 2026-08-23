import githubNotificationCard, {
  githubNotificationMarkdownText,
} from '../conversation/presentation/card.ts';
import githubNotificationAssignmentEventInstructions from '../conversation/prompts/event-assignment.ts';
import githubNotificationPlanningResponseInstructions from '../conversation/prompts/response-planning.ts';
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
  mode: string,
): string {
  return githubNotificationCard({
    emoji: projection.emoji,
    facts: [
      {
        label: 'Assigned by',
        value: `[@${githubNotificationMarkdownText(projection.sender.label)}](${projection.sender.url})`,
      },
      {
        label: projection.item.kind,
        value: `[${githubNotificationMarkdownText(projection.item.label)}](${projection.item.url})`,
      },
      { label: 'Mode', value: mode },
    ],
    title: `${projection.item.kind} assigned`,
  });
}

/** Describe the model-backed assignment planning event. */
const githubNotificationAssignmentEvent = {
  id: 'assignment',
  turn: {
    instructions: githubNotificationAssignmentEventInstructions,
    kind: 'model',
    publicationIntent: 'planning-outcome',
    responseInstructions: githubNotificationPlanningResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationAssignmentEvent;
