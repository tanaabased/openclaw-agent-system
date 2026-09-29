import githubNotificationCard, {
  githubNotificationMarkdownText,
} from '../conversation/presentation/card.ts';
import githubNotificationPullRequestOpenedEventInstructions from '../conversation/prompts/event-pull-request-opened.ts';
import githubNotificationPullRequestOpenedResponseInstructions from '../conversation/prompts/response-pull-request-opened.ts';
import type { GitHubNotificationEvent } from './types.ts';

interface GitHubNotificationPullRequestOpenedPresentationInput {
  issueNumber: number;
  pullRequestNumber: number;
  repositoryName: string;
  repositoryOwner: string;
}

/** Render the shared card for an issue lifecycle's delivery pull request. */
export function githubNotificationPullRequestOpenedCard(
  input: GitHubNotificationPullRequestOpenedPresentationInput,
): string {
  const repository = `${input.repositoryOwner}/${input.repositoryName}`;
  const repositoryUrl =
    `https://github.com/${encodeURIComponent(input.repositoryOwner)}` +
    `/${encodeURIComponent(input.repositoryName)}`;
  return githubNotificationCard({
    emoji: '🔀',
    facts: [
      {
        label: 'Issue',
        value: `[${githubNotificationMarkdownText(`${repository}#${input.issueNumber}`)}](${repositoryUrl}/issues/${input.issueNumber})`,
      },
      {
        label: 'Pull request',
        value: `[${githubNotificationMarkdownText(`${repository}#${input.pullRequestNumber}`)}](${repositoryUrl}/pull/${input.pullRequestNumber})`,
      },
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
export function githubNotificationPullRequestHandoffComment(
  input: GitHubNotificationPullRequestOpenedPresentationInput,
): string {
  if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) {
    throw new Error('GitHub notification pull request numbers must be positive safe integers.');
  }
  return githubNotificationPullRequestOpenedCard(input);
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
