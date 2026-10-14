import workflowInstructions, {
  type WorkflowInstructionsSelection,
  type WorkflowInstructionsPresentation,
} from './workflow-instructions.ts';
import { githubNotificationMarkdownText, githubNotificationQuote } from './card.ts';

export function feedbackReplyPresentation(recipient: string, text: string): string {
  return githubNotificationQuote(
    `## 📤 To [@${githubNotificationMarkdownText(recipient)}](https://github.com/${encodeURIComponent(recipient)})\n\n${text}`,
  );
}

/** display the retained private answer separately from the exact public reply and outcome. */
export default function feedbackResponse(
  input: WorkflowInstructionsPresentation & {
    sourcePresentation?: string;
    selection?: WorkflowInstructionsSelection;
    workspace?: string;
    privateText: string;
    publicReply?: { recipient: string; text: string };
    publication?: { url: string } | { withheld: string };
  },
): string {
  const sections = [
    ...(input.sourcePresentation ? [input.sourcePresentation] : []),
    '## Response',
    input.privateText,
  ];
  if (input.publicReply)
    sections.push(feedbackReplyPresentation(input.publicReply.recipient, input.publicReply.text));
  if (input.publication)
    sections.push(
      'url' in input.publication
        ? `[Published reply ↗](${input.publication.url})`
        : `Public reply withheld: \`${input.publication.withheld}\`.`,
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
