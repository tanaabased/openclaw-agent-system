import publicResponsePresentation from './public-response.ts';
import { githubCommentCard } from './comment.ts';
import workflowInstructions, {
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

/** display the retained private answer separately from the exact public reply and outcome. */
export default function feedbackResponse(
  input: WorkflowInstructionsPresentation & {
    sourcePresentation?: string;
    selection?: WorkflowInstructionsSelection;
    workspace?: string;
    privateText: string;
    publicReply?: { author?: string; text: string };
    publication?: { url: string } | { withheld: string };
  },
): string {
  const sections = [
    ...(input.sourcePresentation ? [input.sourcePresentation] : []),
    '## Response',
    input.privateText,
  ];
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
  const instructions = workflowInstructions(
    'Feedback reply',
    input.selection,
    input.workspace,
    input,
  );
  if (instructions) sections.push(instructions);
  return sections.join('\n\n');
}
