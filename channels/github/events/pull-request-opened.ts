import githubNotificationCard from '../conversation/presentation/card.ts';
import githubNotificationPullRequestOpenedEventInstructions from '../conversation/prompts/event-pull-request-opened.ts';
import githubNotificationPullRequestOpenedResponseInstructions from '../conversation/prompts/response-pull-request-opened.ts';
import type { GitHubNotificationEvent } from './types.ts';

interface GitHubNotificationPullRequestOpenedPresentationInput {
  issueNumber: number;
  pullRequestNumber: number;
  repository: string;
}

/** Render one trusted private card for an issue lifecycle's delivery pull request. */
export function githubNotificationPullRequestOpenedCard(
  input: GitHubNotificationPullRequestOpenedPresentationInput,
): string {
  return githubNotificationCard({
    emoji: '🔀',
    facts: [
      { label: 'Issue', value: `${input.repository}#${input.issueNumber}` },
      { label: 'Pull request', value: `${input.repository}#${input.pullRequestNumber}` },
      {
        label: 'Comment flow',
        value:
          'This issue and its delivery pull request share this session; each reply returns to its originating item.',
      },
    ],
    title: 'Pull request opened',
  });
}

/** Render the deterministic issue comment that announces the delivery pull request. */
export function githubNotificationPullRequestHandoffComment(pullRequestNumber: number): string {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error('GitHub notification pull request numbers must be positive safe integers.');
  }
  return [
    '## Pull request opened',
    '',
    `- **Pull request:** #${pullRequestNumber}`,
    '- **Conversation:** Comments on this issue and its delivery pull request now continue in the same private work session.',
    '- **Replies:** Each response is posted back to the issue or pull request where its comment originated.',
  ].join('\n');
}

const githubNotificationPullRequestOpenedEvent = {
  id: 'pull-request-opened',
  turn: {
    instructions: githubNotificationPullRequestOpenedEventInstructions,
    kind: 'model',
    responseInstructions: githubNotificationPullRequestOpenedResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationPullRequestOpenedEvent;
