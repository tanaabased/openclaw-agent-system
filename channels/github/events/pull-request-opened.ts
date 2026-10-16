import githubNotificationPullRequestOpenedEventInstructions from '../conversation/prompts/event-pull-request-opened.ts';
import githubNotificationPullRequestOpenedResponseInstructions from '../conversation/prompts/response-pull-request-opened.ts';
import type { GitHubNotificationEvent } from './types.ts';

const githubNotificationPullRequestOpenedEvent = {
  id: 'pull-request-opened',
  turn: {
    instructions: githubNotificationPullRequestOpenedEventInstructions,
    kind: 'model',
    responseInstructions: githubNotificationPullRequestOpenedResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationPullRequestOpenedEvent;
