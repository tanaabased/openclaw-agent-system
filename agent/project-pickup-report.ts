import type {
  PickupAllowance,
  PickupScanSummary,
  PickupSelectionGuidance,
} from './project-pickup.ts';
import type { ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import card, {
  githubNotificationMarkdownCode as code,
  githubNotificationMarkdownText as text,
} from '../channels/github/presentation/card.ts';
import debugCard from '../channels/github/presentation/debug.ts';

/** One outcome per native scan. The chat owns history; reports never govern admission. */
export default function projectPickupReport(input: {
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
    assigned: 'Project pickup assigned an issue',
    'allowance-reached': 'Project pickup finished for this window',
    'scan-complete': 'Project pickup already assigned an issue in this scan',
    empty: summary?.eligible
      ? 'Project pickup selected no issue'
      : 'Project pickup found no eligible issues',
    'at-capacity': 'Project pickup is at capacity',
    paused: 'Project pickup is paused',
    idle: 'Project pickup is outside its window',
    cancelled: 'Project pickup scan cancelled',
    expired: 'Project pickup window closed',
    attempted: 'Project pickup assignment needs confirmation',
    failed: 'Project pickup could not finish',
    pending: 'Project pickup could not assign an issue',
  };
  const issueLink = (repo: string, number: number) =>
    `[${text(repo)}#${number}](https://github.com/${repo}/issues/${number})`;
  const message = card({
    emoji: failed ? '❌' : warning ? '⚠️' : '📥',
    title: titles[outcome.status] ?? 'Project pickup checked',
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
    context: 'Project pickup',
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
