import githubNotificationCommentEventInstructions from '../conversation/prompts/event-comment.ts';
import githubNotificationResponseInstructions from '../conversation/prompts/response.ts';
import {
  githubNotificationMarkdownText,
  githubNotificationQuote,
} from '../conversation/presentation/card.ts';
import type { GitHubNotificationEvent } from './types.ts';

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

/** Describe the currently model-backed comment event. */
const githubNotificationCommentEvent = {
  id: 'comment',
  turn: {
    instructions: githubNotificationCommentEventInstructions,
    kind: 'model',
    publicationIntent: 'github-reply',
    publicationSource: 'final',
    responseInstructions: githubNotificationResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationCommentEvent;
