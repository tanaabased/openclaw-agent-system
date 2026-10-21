import { githubNotificationMarkdownText, githubNotificationQuote } from './card.ts';

export interface GitHubNotificationCommentEventProjection {
  author: {
    label: string;
    url: string;
  };
  body: string;
  item: {
    label: string;
    url: string;
  };
}

export interface GitHubCommentCardInput {
  body: string;
  author?: { label: string; url: string };
  label: 'Comment' | 'Reply' | 'Review comment' | 'Plan assessment' | 'PR announcement';
  connector: 'from' | 'by';
  publication: { url: string } | { draft: true };
}

/** wrap exact public prose once; only confirmed sources receive a comment link. */
export function githubCommentCard(input: GitHubCommentCardInput): string {
  const label =
    'url' in input.publication
      ? `[${input.label} ↗](${input.publication.url})`
      : `${input.label} draft`;
  const author = input.author
    ? `[@${githubNotificationMarkdownText(input.author.label)}](${input.author.url})`
    : 'author unavailable';
  return githubNotificationQuote(
    `${input.body}\n\n<br>\n\n*${label} ${input.connector} ${author}*`,
  );
}

/** quote an admitted comment without rewriting its author prose or mentions. */
export function githubNotificationCommentPresentation(
  projection: GitHubNotificationCommentEventProjection,
): string {
  return githubCommentCard({
    body: projection.body,
    author: projection.author,
    label: 'Comment',
    connector: 'from',
    publication: { url: projection.item.url },
  });
}
