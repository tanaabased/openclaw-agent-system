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
  label:
    | 'Comment'
    | 'Reply'
    | 'Review comment'
    | 'Plan assessment'
    | 'PR announcement'
    | 'Original PR announcement';
  connector: 'from' | 'by';
  publication: { url: string } | { draft: true };
}

/** wrap exact public prose once; only confirmed sources receive a comment link. */
export function githubCommentCard(
  input: GitHubCommentCardInput,
  { style = 'quoted' }: { style?: 'quoted' | 'unquoted' } = {},
): string {
  const label =
    'url' in input.publication
      ? `[${input.label} ↗](${input.publication.url})`
      : `${input.label} draft`;
  const author = input.author
    ? `[@${githubNotificationMarkdownText(input.author.label)}](${input.author.url})`
    : 'author unavailable';
  const body = input.body.replace(/\r\n|\r/gu, '\n');
  const card = `${body}\n\n&nbsp;  \n*${label} ${input.connector} ${author}*`;
  return style === 'quoted' ? githubNotificationQuote(card) : card;
}

/** preserve an admitted comment while exposing its verified source. */
export function githubNotificationCommentPresentation(
  projection: GitHubNotificationCommentEventProjection,
): string {
  return githubCommentCard(
    {
      body: projection.body,
      author: projection.author,
      label: 'Comment',
      connector: 'from',
      publication: { url: projection.item.url },
    },
    { style: 'unquoted' },
  );
}
