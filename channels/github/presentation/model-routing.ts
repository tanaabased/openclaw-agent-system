import type { RoutingDecision } from '../../../agent/model-routing.ts';
import type { RoutingInstructions } from '../../../agent/routing-instructions.ts';
import workflowInstructions, {
  fileLink,
  type WorkflowInstructionsPresentation,
  type WorkflowInstructionsSelection,
} from './workflow-instructions.ts';
import githubNotificationCard, {
  githubNotificationMarkdownCode as code,
  githubNotificationMarkdownText as text,
} from './card.ts';

export interface RoutingPresentation extends WorkflowInstructionsPresentation {
  routing: Pick<RoutingDecision, 'complexity' | 'profile' | 'reason' | 'source'> & {
    model: string;
    effort: string;
  };
  effective?: { status: 'verified' | 'unverified'; model?: string; effort?: string };
  executionModel?: string;
  instructions?: RoutingInstructions;
  workspace?: string;
}

export default function modelRoutingCard({
  routing,
  effective,
  executionModel,
  instructions,
  workspace,
  ...presentation
}: RoutingPresentation) {
  const selection: WorkflowInstructionsSelection | undefined = instructions && {
    ...instructions,
    skill: instructions.skill ?? { name: instructions.requestedSkill },
  };
  const method =
    selection && (!selection.defaultSkill || selection.guidance)
      ? (selection.defaultSkill
          ? 'Default routing'
          : fileLink(selection.skill.name, selection.skill.path)) +
        (selection.guidance ? ' + custom guidance' : '')
      : undefined;
  const card = githubNotificationCard({
    emoji: '🧠',
    title: 'Model routing',
    facts: [
      { label: 'Selected', value: code(routing.model) + ' / ' + code(routing.effort) },
      ...(method ? [{ label: 'Routing method', value: method }] : []),
      { label: 'Basis', value: code(routing.complexity) + ' complexity. ' + text(routing.reason) },
      {
        label: 'Source',
        value:
          (routing.profile ? code(routing.profile) + ' profile' : 'Explicit selection') +
          '; ' +
          text(routing.source),
      },
      {
        label: 'Effective settings',
        value:
          effective?.status === 'verified' && effective.model && effective.effort
            ? 'Verified: ' + code(effective.model) + ' / ' + code(effective.effort)
            : 'Not independently verified.',
      },
      {
        label: 'Execution',
        value: executionModel
          ? code(executionModel) + '; effort unverified.'
          : 'Model and effort not independently verified.',
      },
    ],
  });
  return [card, workflowInstructions('Model routing', selection, workspace, presentation)]
    .filter(Boolean)
    .join('\n\n');
}
