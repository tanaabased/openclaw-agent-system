import { assessmentDecisionMode, type AssessmentResult } from '../../../agent/assessment-result.ts';
import redactFeedback from '../../../agent/feedback-redaction.ts';
import type { RoutingDecision } from '../../../agent/model-routing.ts';
import type { RoutingInstructions } from '../../../agent/routing-instructions.ts';
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
  cards?: string[];
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
export default function renderAssessmentResult(
  result: AssessmentResult,
  context: AssessmentPresentationContext,
): string {
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
  const isDebugCard = (card: string) => card.startsWith('> ## 🔬 Debug\n');
  const content = [
    outcomeCard,
    ...cards.filter((card) => !isDebugCard(card)),
    ...(result.decision && !context.assessmentOnly
      ? [
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
        ]
      : []),
    ...(result.reviewSummary && result.reviewSummary.trim() !== result.summary.trim()
      ? ['## Proposed change', result.reviewSummary]
      : []),
    ...(result.outcome === 'clarification-needed'
      ? ['## Question', result.questions.map(item).join('\n\n')]
      : []),
    ...cards.filter(isDebugCard),
  ];
  return content.join('\n\n');
}

/** display-only context travels with the native render request, never as workflow authority. */
export function assessmentContextCards(context: Omit<AssessmentPresentationContext, 'issue'>) {
  return [
    context.routing
      ? modelRoutingCard({
          routing: context.routing,
          effective: context.effective,
          instructions: context.routingInstructions,
          workspace: context.workspace,
          debug: false,
          manifestPath: context.routingManifestPath,
        })
      : undefined,
    workflowConfigurationCard({
      ...context,
      routing: context.routingInstructions && {
        ...context.routingInstructions,
        skill: context.routingInstructions.skill ?? {
          name: context.routingInstructions.requestedSkill,
        },
      },
    }),
  ].filter((card): card is string => card !== undefined);
}
