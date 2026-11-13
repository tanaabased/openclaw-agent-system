import safePresentation from './safe.ts';
import { githubNotificationMarkdownText, githubNotificationQuote } from './card.ts';
import mentionLinks from './mention-links.ts';

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

/** decorate local prose, then wrap it once; only confirmed sources receive a comment link. */
export function githubCommentCard(
  input: GitHubCommentCardInput,
  { style = 'quoted' }: { style?: 'quoted' | 'unquoted' } = {},
): string {
  return safePresentation(
    () => {
      const label =
        'url' in input.publication
          ? `[${input.label} ↗](${input.publication.url})`
          : `${input.label} draft`;
      const author = input.author
        ? `[@${githubNotificationMarkdownText(input.author.label)}](${input.author.url})`
        : 'author unavailable';
      const body = mentionLinks(input.body).replace(/\r\n|\r/gu, '\n');
      const card = `${body}\n\n&nbsp;  \n*${label} ${input.connector} ${author}*`;
      return style === 'quoted' ? githubNotificationQuote(card) : card;
    },
    () =>
      [
        input.body,
        `${input.label} ${'url' in input.publication ? input.publication.url : '(draft)'}`,
        input.author ? `Author: ${input.author.label} (${input.author.url})` : 'Author unavailable',
      ].join('\n\n'),
  );
}

/** link incoming prose mentions without changing the retained provider source. */
export function githubNotificationCommentPresentation(
  projection: GitHubNotificationCommentEventProjection,
): string {
  return safePresentation(
    () =>
      githubCommentCard(
        {
          body: mentionLinks(projection.body),
          author: projection.author,
          label: 'Comment',
          connector: 'from',
          publication: { url: projection.item.url },
        },
        { style: 'unquoted' },
      ),
    () =>
      `${projection.body}\n\nComment: ${projection.item.url}\nAuthor: ${projection.author.label} (${projection.author.url})`,
  );
}
