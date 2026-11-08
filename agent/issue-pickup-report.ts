import type {
  PickupAllowance,
  PickupScanSummary,
  PickupSelectionGuidance,
} from './issue-pickup.ts';
import type { ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import issuePickupLabels from './issue-pickup-labels.ts';
import card, {
  githubNotificationMarkdownCode as code,
  githubNotificationMarkdownText as text,
} from '../channels/github/presentation/card.ts';
import debugCard from '../channels/github/presentation/debug.ts';

/** One outcome per native scan. The chat owns history; reports never govern admission. */
export default function issuePickupReport(input: {
  outcome: {
    status: string;
    repository?: string;
    issue?: number;
    code?: string;
    summary?: PickupScanSummary;
    allowances?: PickupAllowance[];
    providerDiagnostic?: ProviderDiagnostic;
    selectionGuidance?: PickupSelectionGuidance;
  };
  debug?: boolean;
  capacity?: { occupied: number; limit: number };
}) {
  const { outcome } = input;
  if (['material', 'discovering', 'selection-required'].includes(outcome.status))
    return { response: '', notify: false };
  const repository = outcome.repository;
  const allowances = outcome.allowances ?? [];
  const summary = outcome.summary;
  const uncertain = outcome.status === 'attempted';
  const failed = outcome.status === 'failed';
  const warning = uncertain || Boolean(outcome.code) || allowances.some((entry) => entry.code);
  const selected = outcome.status === 'assigned';
  const exhausted = outcome.status === 'allowance-reached';
  const titles: Record<string, string> = {
    assigned: 'Issue pickup assigned an issue',
    'allowance-reached': 'Issue pickup finished for this window',
    'scan-complete': 'Issue pickup already assigned an issue in this scan',
    empty: summary?.eligible
      ? 'Issue pickup selected no issue'
      : 'Issue pickup found no eligible issues',
    'at-capacity': 'Issue pickup is at capacity',
    paused: 'Issue pickup is paused',
    idle: 'Issue pickup is outside its window',
    cancelled: 'Issue pickup scan cancelled',
    expired: 'Issue pickup window closed',
    attempted: 'Issue pickup assignment needs confirmation',
    failed: 'Issue pickup could not finish',
    pending: 'Issue pickup could not assign an issue',
  };
  const issueLink = (repo: string, number: number) =>
    `[${text(repo)}#${number}](https://github.com/${repo}/issues/${number})`;
  const message = card({
    emoji: failed ? '❌' : warning ? '⚠️' : '📥',
    title: titles[outcome.status] ?? 'Issue pickup checked',
    facts: [
      ...allowances.map((entry) => ({
        label: 'Window allowance',
        value: [
          `[${text(entry.repository)}](https://github.com/${entry.repository}/milestone/${entry.milestone})`,
          entry.used === undefined
            ? `limit ${entry.limit}`
            : `${entry.used} of ${entry.limit} assigned`,
          entry.code ? code(entry.code) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      })),
      ...allowances.flatMap((entry) => {
        const filters = entry.filters;
        if (!filters?.labels?.length && !filters?.excludeLabels?.length) return [];
        return [
          {
            label: 'Label filters',
            value: [
              text(entry.repository),
              filters.labels?.length ? `require all: ${filters.labels.map(code).join(', ')}` : '',
              filters.excludeLabels?.length
                ? `exclude any: ${filters.excludeLabels.map(code).join(', ')}`
                : '',
              !issuePickupLabels(filters.labels ?? [], filters)
                ? 'Contradictory criteria: a required label is also excluded. No issue can match.'
                : '',
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ];
      }),
      ...(outcome.status === 'empty' &&
      summary?.eligible === 0 &&
      allowances.some(
        (entry) => entry.filters?.labels?.length || entry.filters?.excludeLabels?.length,
      )
        ? [
            {
              label: 'Filters',
              value:
                'No eligible issues matched within the configured scope. Review the label criteria for a later scan; the search was not widened. Unreadable issues or scopes remain reported separately.',
            },
          ]
        : []),
      ...(summary
        ? [
            {
              label: 'Considered',
              value: `${summary.eligible} eligible issue${summary.eligible === 1 ? '' : 's'}`,
            },
            ...(summary.shortlist.length
              ? [
                  {
                    label: 'Shortlist',
                    value: summary.shortlist
                      .map((issue) => issueLink(issue.repository, issue.number))
                      .join(', '),
                  },
                ]
              : []),
            ...(summary.rationale ? [{ label: 'Why', value: text(summary.rationale) }] : []),
            { label: 'Remaining', value: `${summary.remaining} eligible at the time of this scan` },
            ...(summary.skipped
              ? [{ label: 'Skipped', value: `${summary.skipped} issues could not be read` }]
              : []),
          ]
        : []),
      ...(repository && (outcome.issue ?? summary?.selected?.number)
        ? [
            {
              label: selected ? 'Assigned' : 'Selected',
              value: issueLink(repository, outcome.issue ?? summary!.selected!.number),
            },
          ]
        : []),
      ...(exhausted
        ? [
            {
              label: 'Result',
              value:
                'No further issues will be selected in this window. Ordinary issue intake owns the assigned work.',
            },
          ]
        : []),
      ...(input.capacity && outcome.status === 'at-capacity'
        ? [
            {
              label: 'Active work',
              value: `${input.capacity.occupied} of ${input.capacity.limit} slots occupied. A later scan can check again.`,
            },
          ]
        : []),
      ...(outcome.code ? [{ label: 'Diagnostic', value: code(outcome.code) }] : []),
      ...(outcome.providerDiagnostic
        ? [
            {
              label: 'GitHub',
              value: text(
                outcome.providerDiagnostic.providerMessage ??
                  outcome.providerDiagnostic.explanation,
              ),
            },
          ]
        : []),
      ...(uncertain
        ? [
            {
              label: 'Next',
              value:
                'Confirm the existing assignment attempt on the next scan; do not repeat the assignment request.',
            },
          ]
        : []),
      ...(failed
        ? [
            {
              label: 'Next',
              value: [
                outcome.providerDiagnostic?.explanation ??
                  (outcome.code?.startsWith('dispatch-assessment-guidance-')
                    ? 'Check the configured selection guidance and restore a readable, valid source.'
                    : 'Inspect the diagnostic and resolve the pickup setup or state problem.'),
                'Reconcile any existing assignment attempt before trying again.',
              ].join(' '),
            },
          ]
        : []),
    ],
  });
  const debug = debugCard({
    debug: input.debug,
    context: 'Issue pickup',
    facts: [
      { label: 'Outcome', value: code(outcome.status) },
      ...(outcome.selectionGuidance?.source
        ? [{ label: 'Guidance source', value: code(outcome.selectionGuidance.source) }]
        : []),
      ...(outcome.selectionGuidance?.path
        ? [{ label: 'Guidance file', value: code(outcome.selectionGuidance.path) }]
        : []),
    ],
    ...(input.debug && outcome.selectionGuidance
      ? {
          detail: (() => {
            const content = outcome.selectionGuidance.content.replace(/\r\n?/gu, '\n');
            const fence = '`'.repeat(
              (content.match(/`+/gu) ?? []).reduce(
                (size, run) => Math.max(size, run.length + 1),
                3,
              ),
            );
            return [fence + 'text', content, fence].join('\n');
          })(),
        }
      : {}),
  });
  return { response: [message, debug].filter(Boolean).join('\n\n'), notify: true };
}
