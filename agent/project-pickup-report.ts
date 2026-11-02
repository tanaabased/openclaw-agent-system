import { automationHash } from './automation-hash.ts';
import { pickupRecord, type PickupManagedRecord } from './project-pickup-capacity.ts';
import type { PickupReport, ProjectPickupState } from './project-pickup-state.ts';
import workflowStatus from './workflow-status.ts';
import card, {
  githubNotificationMarkdownCode as code,
  githubNotificationMarkdownText as text,
} from '../channels/github/presentation/card.ts';
import debugCard from '../channels/github/presentation/debug.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';

export type PickupReportRecord = PickupManagedRecord & {
  threadId?: string;
  nativeInactive?: boolean;
};

/** report receipts describe preparation only; they never govern pickup or issue progress. */
export default function projectPickupReport<R extends PickupReportRecord>(input: {
  policy: GitHubNotificationPolicy;
  pickup?: ProjectPickupState;
  records: R[];
  previous?: PickupReport;
  outcome: { status: string; code?: string };
  now: number;
  runId?: string;
  debug?: boolean;
  capacity?: { occupied: number; limit: number };
  active(record: R): boolean | undefined;
  conversation(record: R): string | undefined;
}) {
  const { previous, outcome, pickup } = input;
  if (['discovering', 'selection-required'].includes(outcome.status))
    return { response: '', notify: false };
  if (input.runId && previous?.runId === input.runId) return { ...previous, report: previous };
  const project = input.policy.projectPickup!.projects[0]!;
  const repository = project.repository;
  const url = `https://github.com/${repository}`;
  const items = (pickup?.operations ?? []).map((operation) => {
    const record = pickupRecord(input.records, pickup!, operation);
    const progress = record ? workflowStatus(record) : undefined;
    const blocked =
      progress &&
      [
        'blocked',
        'needs-attention',
        'clarification-needed',
        'policy-held',
        'retrying',
        'result-missing',
        'uncertain',
      ].includes(progress);
    const activity = record ? input.active(record) : undefined;
    const status =
      progress === 'running' || progress === 'assessing'
        ? activity === true
          ? 'running (last observed)'
          : activity === false
            ? 'queued'
            : 'activity unknown'
        : (progress ??
          (['assigned', 'admitted'].includes(operation.phase) ? 'queued' : operation.phase));
    const delivery = record?.delivery ?? record?.work?.delivery;
    return {
      id: operation.id,
      window: operation.window,
      closed: input.now >= operation.window.closesAt,
      issue: operation.selected?.number,
      rationale: operation.rationale,
      status,
      code:
        operation.code ??
        (blocked
          ? (record?.continuation?.code ?? record?.work?.code ?? record?.result?.code ?? progress)
          : undefined),
      conversation: record ? input.conversation(record) : undefined,
      pullRequest: delivery?.reconciled ? delivery.pullRequest?.pullRequestNumber : undefined,
    };
  });
  const informational = [
    'project-pickup-window-closed',
    'project-pickup-native-retired',
    'project-pickup-cancelled',
  ];
  const problems = [
    ...(outcome.code && !informational.includes(outcome.code) ? [outcome.code] : []),
    ...items.flatMap((item) =>
      item.code && !informational.includes(item.code)
        ? [item.id + ':' + item.code]
        : [
              'blocked',
              'needs-attention',
              'clarification-needed',
              'policy-held',
              'retrying',
              'result-missing',
              'uncertain',
            ].includes(item.status)
          ? [item.id + ':' + item.status]
          : [],
    ),
  ];
  const uniqueProblems = [...new Set(problems)].sort();
  const recovered = Boolean(
    previous?.problems.length &&
    !uniqueProblems.length &&
    ['assigned', 'admitted', 'completed'].includes(outcome.status),
  );
  const visible = items.filter((item) => item.issue || item.closed || item.code);
  const facts = {
    repository,
    milestone: project.milestone.number,
    items: visible,
    problems: uniqueProblems,
    capacity: input.capacity,
  };
  const fingerprint = automationHash(facts);
  const notify =
    fingerprint !== previous?.fingerprint &&
    Boolean(visible.length || uniqueProblems.length || recovered);
  const closed = visible.at(-1)?.closed === true;
  const warning = uniqueProblems.length > 0;
  const failed = outcome.status === 'failed';
  const uncertain = uniqueProblems.some((problem) =>
    /assignment-(uncertain|unverified|history-incomplete)$/u.test(problem),
  );
  const next = uncertain
    ? 'Preserve the uncertain assignment. The next pickup check reconciles the same operation; do not assign it again.'
    : failed
      ? 'Check the diagnostic and GitHub access. Resolve or cancel the retained pickup operation through its owning coordinator before selecting again.'
      : 'Open the issue chat to resolve its work blocker. Implementation stays in that chat.';
  const body = card({
    emoji: warning ? (failed ? '❌' : '⚠️') : '💡',
    title: warning
      ? failed
        ? 'Project pickup could not finish'
        : 'Project pickup needs attention'
      : recovered
        ? 'Project pickup resumed'
        : closed
          ? 'Pickup window summary'
          : 'Project pickup selected',
    facts: [
      { label: 'Repository', value: `[${text(repository)}](${url})` },
      {
        label: 'Milestone',
        value: `[#${project.milestone.number}](${url}/milestone/${project.milestone.number})`,
      },
      ...(input.capacity
        ? [
            {
              label: 'Slots',
              value: `${input.capacity.occupied}/${input.capacity.limit} occupied`,
            },
          ]
        : []),
      ...visible.slice(-12).flatMap((item) => [
        {
          label: 'Window',
          value: `${new Date(item.window.opensAt).toISOString()} – ${new Date(item.window.closesAt).toISOString()} · ${item.closed ? 'closed' : 'open'}`,
        },
        ...(item.issue
          ? [
              {
                label: 'Issue',
                value: `[${text(repository)}#${item.issue}](${url}/issues/${item.issue}) · ${text(item.status)}`,
              },
            ]
          : [{ label: 'Status', value: text(item.status) }]),
        ...(item.rationale
          ? [{ label: item.issue ? 'Why selected' : 'Selection', value: text(item.rationale) }]
          : []),
        ...(item.conversation
          ? [
              {
                label: 'Work chat',
                value: `[${item.issue ? '#' + item.issue : 'Issue'}](${item.conversation})`,
              },
            ]
          : []),
        ...(item.pullRequest
          ? [
              {
                label: 'PR delivery',
                value: `[#${item.pullRequest}](${url}/pull/${item.pullRequest}) · ${item.status === 'delivered' ? 'delivered' : item.status === 'delivered-response-pending' ? 'response pending' : 'existing PR'}`,
              },
            ]
          : []),
      ]),
      ...(warning
        ? [
            { label: 'What happened', value: 'Project pickup or selected work needs attention.' },
            {
              label: 'Diagnostic',
              value: uniqueProblems
                .map((problem) => code(problem.slice(problem.indexOf(':') + 1)))
                .join(' · '),
            },
            {
              label: 'Next step',
              value: next,
            },
          ]
        : []),
      ...(recovered
        ? [{ label: 'Recovery', value: 'The earlier reported blocker has cleared.' }]
        : []),
      ...(closed
        ? [
            {
              label: 'Window closed',
              value:
                'Pickup has closed for this window. Issue work and PR delivery are reported separately; closure does not mean completion.',
            },
          ]
        : []),
    ],
  });
  const debug = debugCard({
    debug: input.debug,
    context: 'Project pickup',
    facts: [{ label: 'Outcome', value: code(outcome.status) }],
  });
  const message = notify ? [body, debug].filter(Boolean).join('\n\n') : '';
  const response = message;
  const report: PickupReport = {
    fingerprint,
    problems: uniqueProblems,
    response,
    notify,
    ...(input.runId ? { runId: input.runId } : {}),
  };
  return { response, notify, report };
}
