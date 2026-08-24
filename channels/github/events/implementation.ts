import githubNotificationCard from '../conversation/presentation/card.ts';
import githubNotificationImplementationEventInstructions from '../conversation/prompts/event-implementation.ts';
import githubNotificationImplementationResponseInstructions from '../conversation/prompts/response-implementation.ts';
import type { GitHubNotificationEvent } from './types.ts';

/** Render the private continuation that follows one published Work plan. */
export function githubNotificationImplementationCard(issueNumber: number): string {
  return githubNotificationCard({
    emoji: '🛠️',
    summary: `The public plan for issue #${issueNumber} is published. Carry it out now in \`work\` mode, ending with one local commit. Lifecycle delivery follows.`,
    title: 'Implementation started',
  });
}

/** Describe the registered private implementation event without scheduling it. */
const githubNotificationImplementationEvent = {
  id: 'implementation',
  turn: {
    instructions: githubNotificationImplementationEventInstructions,
    kind: 'model',
    responseInstructions: githubNotificationImplementationResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationImplementationEvent;
