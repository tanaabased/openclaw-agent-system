import workflowInstructions, {
  type WorkflowInstructionsSelection,
  type WorkflowInstructionsPresentation,
} from './workflow-instructions.ts';

/** display the retained private answer separately from the exact public reply and outcome. */
export default function feedbackResponse(
  input: WorkflowInstructionsPresentation & {
    sourcePresentation?: string;
    selection?: WorkflowInstructionsSelection;
    workspace?: string;
    privateText: string;
    publicText?: string;
    publication?: { url: string } | { withheld: string };
  },
): string {
  const sections = [
    ...(input.sourcePresentation ? [input.sourcePresentation] : []),
    '## Response',
    input.privateText,
  ];
  if (input.publicText)
    sections.push(
      ('## 📤 To GitHub\n\n' + input.publicText)
        .split(/\r\n|\r|\n/u)
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n'),
    );
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
