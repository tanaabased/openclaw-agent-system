import composeResponseBlocks, { responseBlocks, type ResponseBlock } from './response-blocks.ts';
import {
  assessmentDecisionMode,
  type AssessmentResult,
} from '../../../agent/tasks/assessment/assessment-result.ts';
import redactFeedback from '../../../agent/tasks/feedback/feedback-redaction.ts';
import type { RoutingDecision } from '../../../agent/models/model-routing.ts';
import type { RoutingInstructions } from '../../../agent/models/routing-instructions.ts';
import githubNotificationCard, {
  githubNotificationMarkdownCode,
  githubNotificationMarkdownText,
  githubNotificationQuote,
} from './card.ts';
import modelRoutingCard from './model-routing.ts';
import {
  workflowConfigurationCard,
  type WorkflowInstructionsPresentation,
  type WorkflowInstructionsSelection,
} from './workflow-instructions.ts';

export interface AssessmentPresentationContext extends WorkflowInstructionsPresentation {
  cards?: ResponseBlock[];
  issue: { label: string; url: string; kind?: 'Issue' | 'Pull request' };
  assessmentOnly?: boolean;
  routing?: Pick<RoutingDecision, 'complexity' | 'profile' | 'reason' | 'source'> & {
    model: string;
    effort: string;
  };
  effective?: { status: 'verified' | 'unverified'; model?: string; effort?: string };
  workspace?: string;
  assessment?: WorkflowInstructionsSelection;
  routingInstructions?: RoutingInstructions;
  routingManifestPath?: string;
}

function item(markdown: string): string {
  return '- ' + markdown.replace(/\n/g, '\n  ');
}

/** frame a validated result without interpreting its prose as state or routing authority. */
export function assessmentResponseBlocks(
  result: AssessmentResult,
  context: AssessmentPresentationContext,
): ResponseBlock[] {
  const titles = {
    'plan-ready': '🧭 Plan ready',
    'clarification-needed': '❓ Clarification needed',
    'operator-setup-blocker': '⏸️ Issue assessment blocked',
  };
  const text = githubNotificationMarkdownText;
  const outcomeCard = githubNotificationQuote(
    [
      '## ' + titles[result.outcome],
      result.summary,
      ...(context.assessmentOnly
        ? ['Assessment only. No implementation or publication is authorized.']
        : []),
      '**' +
        (context.issue.kind ?? 'Issue') +
        ':** [' +
        text(context.issue.label) +
        '](' +
        context.issue.url +
        ')',
      ...(result.outcome === 'operator-setup-blocker'
        ? [
            '## Action',
            result.remediation,
            '**Diagnostic:** ' + githubNotificationMarkdownCode(result.code),
          ]
        : []),
    ].join('\n\n'),
  );
  const cards = context.cards ?? assessmentContextCards(context);
  const content = [
    ...responseBlocks('assessment', outcomeCard, 'outcome'),
    ...cards.filter((card) => card.section !== 'debug'),
    ...(result.decision && !context.assessmentOnly
      ? responseBlocks(
          'assessment',
          githubNotificationCard({
            emoji: assessmentDecisionMode(result.decision) === 'plan' ? '⏸️' : '▶️',
            title: 'Auto mode decision',
            facts: [
              {
                label: 'Decision',
                value: githubNotificationMarkdownCode(result.decision.mode),
              },
              {
                label: 'Next',
                value:
                  assessmentDecisionMode(result.decision) === 'plan'
                    ? result.outcome === 'clarification-needed'
                      ? 'Waiting for the missing answers before implementation.'
                      : 'Await your direction before implementation.'
                    : 'Continue automatically once runtime checks pass.',
              },
              ...result.decision.reasons.map((reason) => ({
                label: 'Reason',
                value: text(redactFeedback(reason)),
              })),
            ],
          }),
          'decision',
        )
      : []),
    ...(result.reviewSummary && result.reviewSummary.trim() !== result.summary.trim()
      ? responseBlocks('assessment', '## Proposed change\n\n' + result.reviewSummary, 'review')
      : []),
    ...(result.outcome === 'clarification-needed'
      ? responseBlocks(
          'assessment',
          '## Question\n\n' + result.questions.map(item).join('\n\n'),
          'questions',
        )
      : []),
    ...cards.filter((card) => card.section === 'debug'),
  ];
  return content.map((block, index) => ({
    ...block,
    source: `assessment:${context.issue.url}:${block.source ?? index}`,
  }));
}

export default function renderAssessmentResult(
  result: AssessmentResult,
  context: AssessmentPresentationContext,
): string {
  return composeResponseBlocks(assessmentResponseBlocks(result, context));
}

/** display-only context travels with the native render request, never as workflow authority. */
export function assessmentContextCards(context: Omit<AssessmentPresentationContext, 'issue'>) {
  return [
    ...responseBlocks(
      'assessment',
      context.routing
        ? modelRoutingCard({
            routing: context.routing,
            effective: context.effective,
            instructions: context.routingInstructions,
            workspace: context.workspace,
            debug: false,
            manifestPath: context.routingManifestPath,
          })
        : '',
      'routing',
    ),
    ...responseBlocks(
      'debug',
      workflowConfigurationCard({
        ...context,
        routing: context.routingInstructions && {
          ...context.routingInstructions,
          skill: context.routingInstructions.skill ?? {
            name: context.routingInstructions.requestedSkill,
          },
        },
      }) ?? '',
      'configuration',
    ),
  ];
}
