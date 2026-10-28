import githubNotificationCard, { githubNotificationMarkdownText } from './card.ts';

interface GitHubNotificationPullRequestOpenedPresentationInput {
  commentFlow?: 'openclaw' | 'codex' | 'unavailable' | 'unverified' | 'omit';
  issueNumber?: number;
  updated?: boolean;
  pullRequestNumber: number;
  repositoryName: string;
  repositoryOwner: string;
}

export function githubNotificationPullRequestOpenedCard(
  input: GitHubNotificationPullRequestOpenedPresentationInput,
): string {
  const repository = `${input.repositoryOwner}/${input.repositoryName}`;
  const repositoryUrl =
    `https://github.com/${encodeURIComponent(input.repositoryOwner)}` +
    `/${encodeURIComponent(input.repositoryName)}`;
  return githubNotificationCard(
    {
      emoji: '🔀',
      facts: [
        ...(input.issueNumber
          ? [
              {
                label: 'Issue',
                value: `[${githubNotificationMarkdownText(`${repository}#${input.issueNumber}`)}](${repositoryUrl}/issues/${input.issueNumber})`,
              },
            ]
          : []),
        {
          label: 'Pull request',
          value: `[${githubNotificationMarkdownText(`${repository}#${input.pullRequestNumber}`)}](${repositoryUrl}/pull/${input.pullRequestNumber})`,
        },
        ...(input.commentFlow === 'omit' || input.updated
          ? []
          : [
              {
                label: 'Comment flow',
                value:
                  input.commentFlow === 'unavailable'
                    ? 'This pull request is linked to the original issue chat. Automatic GitHub feedback delivery is not available.'
                    : input.commentFlow === 'unverified'
                      ? 'This pull request is linked to the original issue chat. Feedback is configured, but its active intake could not be verified.'
                      : input.commentFlow === 'codex' || input.commentFlow === 'openclaw'
                        ? 'Approved feedback on this issue and its delivery pull request returns to the original issue chat; public replies return to their originating item or review thread.'
                        : 'This issue and its delivery pull request share this session; each reply returns to its originating item.',
              },
            ]),
      ],
      title: input.updated ? 'Pull request updated' : 'Pull request opened',
    },
    { quoted: true },
  );
}
