import type { AssessmentResult } from '../../../../agent/assessment-result.ts';
import type { RoutingDecision } from '../../../../agent/model-routing.ts';
import githubNotificationCard, { githubNotificationMarkdownText } from './card.ts';

interface AssessmentPresentationContext {
  issue: { label: string; url: string };
  routing: Pick<RoutingDecision, 'complexity' | 'profile' | 'reason' | 'source'> & {
    model: string;
    effort: string;
  };
  effective?: { status: 'verified' | 'unverified'; model?: string; effort?: string };
  assessment?: {
    defaultSkill: boolean;
    skill: { name: string };
    guidance?: { source: 'inline' | 'file'; path?: string; content: string };
  };
}

function item(markdown: string): string {
  return '- ' + markdown.replace(/\n/g, '\n  ');
}

function quote(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
}

function literalText(value: string): string {
  const fence = '`'.repeat(
    (value.match(/`+/gu) ?? []).reduce((size, run) => Math.max(size, run.length + 1), 3),
  );
  return [fence + 'text', value.replace(/\r\n?/gu, '\n'), fence].join('\n');
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
  const { routing, effective, assessment } = context;
  const text = githubNotificationMarkdownText;
  const routingCard = quote(
    githubNotificationCard({
      emoji: '🧠',
      title: 'Model routing',
      facts: [
        { label: 'Selected', value: text(routing.model + ' / ' + routing.effort) },
        { label: 'Basis', value: text(routing.complexity + ' complexity. ' + routing.reason) },
        {
          label: 'Source',
          value: text(
            (routing.profile ? routing.profile + ' profile' : 'Explicit selection') +
              '; ' +
              routing.source,
          ),
        },
        {
          label: 'Effective settings',
          value:
            effective?.status === 'verified' && effective.model && effective.effort
              ? 'Verified: ' + text(effective.model + ' / ' + effective.effort)
              : 'Not independently verified.',
        },
      ],
    }),
  );
  const instructionFacts = [
    ...(assessment && !assessment.defaultSkill
      ? [{ label: 'Skill', value: text(assessment.skill.name) }]
      : []),
    ...(assessment?.guidance
      ? [
          {
            label: 'Guidance',
            value:
              assessment.guidance.source === 'file'
                ? text(assessment.guidance.path ?? 'Guidance file')
                : 'Inline guidance',
          },
        ]
      : []),
  ];
  const instructionsCard = instructionFacts.length
    ? quote(
        [
          githubNotificationCard({
            emoji: '🧩',
            title: 'Assessment instructions',
            facts: instructionFacts,
          }),
          ...(assessment?.guidance?.source === 'inline'
            ? [literalText(assessment.guidance.content)]
            : []),
        ].join('\n\n'),
      )
    : undefined;
  const content = [
    '## ' + titles[result.outcome],
    result.summary,
    '**Issue:** [' + text(context.issue.label) + '](' + context.issue.url + ')',
    ...('assessment' in result ? ['## Assessment', result.assessment] : []),
    routingCard,
    ...(instructionsCard ? [instructionsCard] : []),
    ...(result.outcome === 'plan-ready'
      ? [
          ...(result.planSummary ? ['## Plan summary', result.planSummary] : []),
          '## Full plan',
          result.plan,
        ]
      : result.outcome === 'clarification-needed'
        ? ['## Question', result.questions.map(item).join('\n\n')]
        : ['## Action', result.remediation, '**Diagnostic:** `' + result.code + '`']),
  ];
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
