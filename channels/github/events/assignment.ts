import githubNotificationCard, {
  githubNotificationMarkdownText,
} from '../conversation/presentation/card.ts';
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
    summary: `[@${githubNotificationMarkdownText(projection.sender.label)}](${projection.sender.url}) assigned you to [${githubNotificationMarkdownText(projection.item.label)}](${projection.item.url}). Please begin working on it in **${githubNotificationMarkdownText(mode)} mode**.`,
    title: `${projection.item.kind} assigned`,
  });
}

/** Describe the currently observe-only assignment event. */
const githubNotificationAssignmentEvent = {
  id: 'assignment',
  turn: { kind: 'observe-only' },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationAssignmentEvent;
