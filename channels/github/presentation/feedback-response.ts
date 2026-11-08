import publicResponsePresentation from './public-response.ts';
import { githubCommentCard } from './comment.ts';
import {
  type WorkflowInstructionsSelection,
  type WorkflowInstructionsPresentation,
} from './workflow-instructions.ts';

export function feedbackReplyPresentation(
  author: string | undefined,
  text: string,
  url?: string,
): string {
  return githubCommentCard({
    body: text,
    author: author
      ? { label: author, url: `https://github.com/${encodeURIComponent(author)}` }
      : undefined,
    label: 'Reply',
    connector: 'from',
    publication: url ? { url } : { draft: true },
  });
}

/** render one reply, retaining distinct private context and publication outcomes. */
export default function feedbackResponse(
  input: WorkflowInstructionsPresentation & {
    selection?: WorkflowInstructionsSelection;
    workspace?: string;
    privateText: string;
    publicReply?: { author?: string; text: string };
    publication?: { url: string } | { withheld: string };
  },
): string {
  const comparable = (text: string) => text.replace(/\r\n?/gu, '\n').trim();
  const publicText = input.publicReply ? comparable(input.publicReply.text) : undefined;
  const privateText = comparable(input.privateText);
  // publication may prepend a standalone verified commenter mention; keep it in the quote.
  const repeated =
    publicText !== undefined &&
    (privateText === publicText ||
      privateText === publicText.replace(/^@[A-Za-z0-9][A-Za-z0-9-]*\n\n/u, ''));
  const sections: string[] = [];
  if (!repeated) {
    if (input.publicReply) sections.push('## Private context');
    sections.push(input.privateText);
  }
  if (input.publicReply)
    sections.push(
      feedbackReplyPresentation(
        input.publicReply.author,
        input.publicReply.text,
        input.publication && 'url' in input.publication ? input.publication.url : undefined,
      ),
    );
  if (input.publication && 'withheld' in input.publication)
    sections.push(
      publicResponsePresentation({
        kind: 'Public reply',
        code: input.publication.withheld,
        attempted: /unconfirmed/.test(input.publication.withheld),
        withheld: /private-only|not-required|self-publication/.test(input.publication.withheld),
      }),
    );
  return sections.join('\n\n');
}
