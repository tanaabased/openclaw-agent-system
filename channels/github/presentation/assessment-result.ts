import { assessmentDecisionMode, type AssessmentResult } from '../../../agent/assessment-result.ts';
import modelRoutingCard from './model-routing.ts';
import redactCodexFeedback from '../../../agent/codex-feedback-redaction.ts';
import type { RoutingDecision } from '../../../agent/model-routing.ts';
import type { RoutingInstructions } from '../../../agent/routing-instructions.ts';
import {
  workflowConfigurationCard,
  type WorkflowInstructionsSelection,
  type WorkflowInstructionsPresentation,
} from './workflow-instructions.ts';
import githubNotificationCard, {
  githubNotificationMarkdownCode,
  githubNotificationMarkdownText,
  githubNotificationQuote,
} from './card.ts';

export interface AssessmentPresentationContext extends WorkflowInstructionsPresentation {
  cards?: string[];
  includeDetails?: boolean;
  retained?: boolean;
  issue: { label: string; url: string; kind?: 'Issue' | 'Pull request' };
  assessmentOnly?: boolean;
  routing?: Pick<RoutingDecision, 'complexity' | 'profile' | 'reason' | 'source'> & {
    model: string;
    effort: string;
  };
  effective?: { status: 'verified' | 'unverified'; model?: string; effort?: string };
  workspace?: string;
  assessment?: WorkflowInstructionsSelection;
  metadataLimitation?: { code: string };
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
  // omit only verbatim duplicates; never infer dispensable content from prose or skill identity.
  const source = result.fullAssessment ?? (result.outcome === 'plan-ready' ? result.plan : '');
  const reviewOnly = !!result.reviewSummary && !!result.fullAssessment && !context.includeDetails;
  const needsSection = (value: string) => value !== result.summary && !source.includes(value);
  const cards = context.cards ?? assessmentContextCards(context);
  const isDebugCard = (card: string) => card.startsWith('> ## 🔬 Debug\n');
  const content = [
    outcomeCard,
    ...(!reviewOnly && 'assessment' in result && needsSection(result.assessment)
      ? ['## Assessment', result.assessment]
      : []),
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
                value: text(redactCodexFeedback(reason)),
              })),
            ],
          }),
        ]
      : []),
    ...(reviewOnly && result.reviewSummary!.trim() !== result.summary.trim()
      ? ['## Proposed change', result.reviewSummary!]
      : []),
    ...(!reviewOnly && result.outcome === 'plan-ready'
      ? [
          ...(result.planSummary && needsSection(result.planSummary)
            ? ['## Plan summary', result.planSummary]
            : []),
          ...(!result.fullAssessment ? ['## Full plan', result.plan] : []),
        ]
      : result.outcome === 'clarification-needed'
        ? ['## Question', result.questions.map(item).join('\n\n')]
        : []),
    ...(!reviewOnly && result.fullAssessment ? ['## Full assessment', result.fullAssessment] : []),
    ...(!reviewOnly &&
    result.outcome === 'plan-ready' &&
    result.fullAssessment &&
    !source.includes(result.plan)
      ? ['## Full plan', result.plan]
      : []),
    ...cards.filter(isDebugCard),
  ];
  if (reviewOnly && context.retained !== false)
    content.push(
      'The full assessment and engineering plan are saved for implementation. Ask for the full assessment to inspect them.',
    );
  if (!context.includeDetails) return content.join('\n\n');
  const hasInvestigation = result.progress.completed.length || result.progress.remaining.length;
  if (result.evidence.length || hasInvestigation) {
    content.push(
      '## Reference material',
      'Optional supporting detail: sources and investigation notes.',
    );
  }
  if (result.evidence.length) {
    content.push(
      '### Evidence',
      result.evidence
        .map(({ source, status, detail }) =>
          item('**' + status + ':** ' + source + '\n\n' + detail),
        )
        .join('\n\n'),
    );
  }
  if (hasInvestigation) {
    content.push('### Investigation');
    for (const [label, entries] of [
      ['Completed', result.progress.completed],
      ['Remaining', result.progress.remaining],
    ] as const) {
      if (entries.length) content.push('#### ' + label, entries.map(item).join('\n\n'));
    }
  }
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
    context.metadataLimitation
      ? githubNotificationCard({
          emoji: '⚠️',
          title: 'Warning',
          facts: [
            {
              label: 'What happened',
              value:
                'The assessment is shown, but its current skill and guidance metadata could not be refreshed.',
            },
            {
              label: 'Next step',
              value:
                'Continue from the assessment. Recover the missing guidance only before work that requires it; no reassessment or republication is needed.',
            },
            {
              label: 'Technical detail',
              value: githubNotificationMarkdownCode(context.metadataLimitation.code),
            },
          ],
        })
      : undefined,
  ].filter((card): card is string => card !== undefined);
}
