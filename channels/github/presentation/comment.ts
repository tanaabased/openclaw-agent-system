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

/** quote an admitted comment without rewriting its author prose or mentions. */
export function githubNotificationCommentPresentation(
  projection: GitHubNotificationCommentEventProjection,
): string {
  const heading = `## 💬 From [@${githubNotificationMarkdownText(projection.author.label)}](${projection.author.url})`;
  const footer = `[View comment on ${githubNotificationMarkdownText(projection.item.label)} ↗](${projection.item.url})`;
  return githubNotificationQuote([heading, '', projection.body, '', footer].join('\n'));
}
