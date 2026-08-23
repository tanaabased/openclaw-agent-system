import githubNotificationCommentEventInstructions from '../conversation/prompts/event-comment.ts';
import githubNotificationResponseInstructions from '../conversation/prompts/response.ts';
import { githubNotificationMarkdownText } from '../conversation/presentation/card.ts';
import type { GitHubCommentMention } from '../conversation/comment-admission.ts';
import type { GitHubNotificationEvent } from './types.ts';

export interface GitHubNotificationCommentEventProjection {
  agent: {
    emoji: string;
    label: string;
    url: string;
  };
  author: {
    label: string;
    url: string;
  };
  body: string;
  item: {
    label: string;
    url: string;
  };
  mentions: readonly GitHubCommentMention[];
}

function replaceMentions(
  body: string,
  mentions: readonly GitHubCommentMention[],
  replacement: string,
): string {
  let cursor = 0;
  let presented = '';
  for (const mention of mentions) {
    if (
      !Number.isSafeInteger(mention.start) ||
      !Number.isSafeInteger(mention.end) ||
      mention.start < cursor ||
      mention.end <= mention.start ||
      mention.end > body.length ||
      body[mention.start] !== '@'
    ) {
      throw new Error('GitHub notification comment mention ranges are invalid.');
    }
    presented += `${body.slice(cursor, mention.start)}${replacement}`;
    cursor = mention.end;
  }
  if (cursor === 0) {
    throw new Error('GitHub notification comment presentation requires an admitted mention.');
  }
  return `${presented}${body.slice(cursor)}`;
}

/** Render one admitted comment with trusted agent and source identity. */
export function githubNotificationCommentPresentation(
  projection: GitHubNotificationCommentEventProjection,
): string {
  const agentLabel = githubNotificationMarkdownText(projection.agent.label);
  const agentReference = `${githubNotificationMarkdownText(projection.agent.emoji)} [${agentLabel}](${projection.agent.url})`;
  const body = replaceMentions(projection.body, projection.mentions, agentReference);
  const footer = `> _[@${githubNotificationMarkdownText(projection.author.label)}](${projection.author.url}) mentioned ${agentLabel} on [${githubNotificationMarkdownText(projection.item.label)}](${projection.item.url})._`;
  return `${body}\n\n${footer}`;
}

/** Describe the currently model-backed comment event. */
const githubNotificationCommentEvent = {
  id: 'comment',
  turn: {
    instructions: githubNotificationCommentEventInstructions,
    kind: 'model',
    publicationIntent: 'github-reply',
    responseInstructions: githubNotificationResponseInstructions,
  },
} as const satisfies GitHubNotificationEvent;

export default githubNotificationCommentEvent;
