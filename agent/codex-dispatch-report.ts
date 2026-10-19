import codexFeedbackProblem from './codex-feedback-problem.ts';
import workflowStatus from './workflow-status.ts';
import discoveryNotice from './discovery-notice.ts';
import codexCapacity, {
  legacyRetiredReservation,
  codexItemOccupied,
  codexUnresolvedRetirement,
} from './codex-capacity.ts';
import workflowRecovery from './workflow-recovery.ts';
import { automationHash } from './automation-hash.ts';
import codexHeartbeat, { codexHeartbeatEnvelope } from './codex-heartbeat.ts';
import codexIssueNotice from './codex-issue-notice.ts';
import intakeAutomationNotice from '../channels/github/presentation/intake-automation-notice.ts';
import pendingDispatchAssignments, { issueKey } from './dispatch-pending.ts';
import type { DispatchState } from './codex-dispatch-state.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';
import {
  githubNotificationMarkdownText as text,
  githubNotificationQuote,
} from '../channels/github/presentation/card.ts';

/** summarize intake facts only; assessment results never become intake announcements. */
export default function prepareDispatchReport(input: {
  state: DispatchState;
  intake: IntakeState;
  slots: number;
  automationId: string;
  currentTimeIso: string;
}) {
  const { state, intake } = input;
  const discovery = discoveryNotice(state.discoveryProgress);
  const active = state.records.filter(
    (record) => !record.retired && !record.retirement && !record.reset,
  );
  const retirementPending = state.records.filter(
    (record) => record.retirement && !record.retired,
  ).length;
  const managing = active.filter((record) => record.effective && record.threadId);
  const waitingIssues = new Set(
    pendingDispatchAssignments(state, intake)
      .filter(({ record }) => !record?.request)
      .map(({ intake: item }) => issueKey(item)),
  );
  const historical = state.records.filter(
    (record) =>
      codexUnresolvedRetirement(record) &&
      (codexItemOccupied(record) || waitingIssues.has(record.issueKey)),
  );
  const occupied = codexCapacity(state.records, input.slots).occupied;
  const pending = pendingDispatchAssignments(state, intake, codexUnresolvedRetirement).length;
  const feedback = active.flatMap((record) =>
    (record.feedback?.events ?? []).map((event) => ({ record, event })),
  );
  const sent = feedback.filter(({ event }) => event.attempt?.turnId && !event.reported);
  const queuedFeedback = feedback.filter(({ event }) => event.phase === 'queued');
  const feedbackProblems = active.filter(codexFeedbackProblem);

  const started = managing
    .filter((record) => record.dispatchedAt !== undefined && record.intakeReportedAt === undefined)
    .slice(0, 12);
  const problems = active.filter(
    (record) =>
      !record.effective &&
      ['blocked', 'waiting', 'retrying'].includes(record.phase) &&
      record.result?.outcome === 'operator-setup-blocker',
  );
  const failures = [
    ...(intake.blocker
      ? [{ id: 'scan', code: intake.blocker.code, operation: 'assignment scan' }]
      : []),
    ...feedbackProblems.map((record) => ({
      id: record.id,
      code: record.feedback!.code!,
      operation: 'feedback',
    })),
    ...problems.map((record) => ({
      id: record.id,
      operation: 'assignment preparation',
      code: record.result!.outcome === 'operator-setup-blocker' ? record.result!.code : '',
    })),
  ];
  const history = historical.map((record) => ({
    id: record.id,
    code: record.capacityObservation?.code ?? 'dispatch-capacity-observation-required',
  }));
  const health = failures.length || history.length ? automationHash({ failures, history }) : '';
  const recovered = !health && Boolean(state.intakeHealth);
  const notices = failures.map((failure) => ({
    ...failure,
    ...codexIssueNotice({
      event: 'failure',
      code: failure.code,
      changed: health !== state.intakeHealth,
    }),
  }));
  const severity = notices.some((notice) => notice.severity === 'error')
    ? 'error'
    : notices.some((notice) => notice.severity === 'warning')
      ? 'warning'
      : 'info';
  const issueLabel = (intakeId: string) => {
    const item = intake.records.find((entry) => entry.id === intakeId);
    return item
      ? text(item.repository.owner.login + '/' + item.repository.name + '#' + item.issue.number)
      : 'Issue';
  };
  const quiet = codexHeartbeat({
    automationId: input.automationId,
    currentTimeIso: input.currentTimeIso,
    intake: { status: 'ready', changed: false },
    dispatch: [{ status: 'idle', changed: false }],
  });
  if (quiet.status !== 'quiet') throw new Error('heartbeat-request-invalid');
  const automationNotice = intakeAutomationNotice(intake.blocker?.code ?? '');
  const title =
    automationNotice && notices.length === 1
      ? `${automationNotice.emoji} ${automationNotice.title}`
      : notices.length
        ? !intake.blocker
          ? '⚠️ Intake checked — some items need attention'
          : severity === 'error'
            ? '❌ Intake could not finish'
            : '⚠️ Intake needs attention'
        : started.length
          ? `💡 Intake complete — ${started.length} issue${started.length === 1 ? '' : 's'} started${sent.length ? ` · ${sent.length} feedback delivered to chats` : ''}`
          : sent.length
            ? `💡 Intake complete — ${sent.length} feedback item${sent.length === 1 ? '' : 's'} delivered to chats`
            : recovered
              ? '💡 Intake resumed'
              : pending
                ? `💡 Intake checked — ${pending} issue${pending === 1 ? '' : 's'} pending`
                : '💡 Intake checked';
  const lines = ['## ' + title, ''];
  if (recovered) lines.push('The earlier intake problem has cleared.', '');
  for (const record of started)
    lines.push(
      `- **Issue:** [${issueLabel(record.intakeId)}](codex://threads/${encodeURIComponent(record.threadId!)})`,
    );
  if (started.length) lines.push('');
  const sentOwners = new Map<string, { record: (typeof active)[number]; count: number }>();
  for (const { record } of sent) {
    const owner = sentOwners.get(record.id);
    if (owner) owner.count++;
    else sentOwners.set(record.id, { record, count: 1 });
  }
  for (const { record, count } of sentOwners.values())
    lines.push(
      `- **Feedback delivered to chat:** [${issueLabel(record.intakeId)}](codex://threads/${encodeURIComponent(record.threadId!)}) · ${count} item${count === 1 ? '' : 's'}`,
    );
  if (sent.length) lines.push('');
  for (const notice of notices.slice(0, 12)) {
    const record = active.find((entry) => entry.id === notice.id);
    if (notice.id === 'scan' && intakeAutomationNotice(notice.code)) {
      lines.push(
        `- **What happened:** ${notice.summary}`,
        `- **Next step:** ${notice.next}`,
        `- **Technical detail:** \`${notice.code}\``,
      );
      continue;
    }
    lines.push(
      `- **${record ? 'Issue: ' + issueLabel(record.intakeId) : 'Intake'}:** ${notice.summary}`,
      `  **Operation:** ${notice.operation}`,
      `  **Action:** ${notice.operation === 'assignment preparation' && record?.result?.outcome === 'operator-setup-blocker' ? text(record.result.remediation) : notice.next}`,
      ...(record ? [`  **Status:** ${workflowStatus(record)}`] : []),
      `  **Diagnostic:** \`${notice.code}\``,
    );
    if (
      notice.code === 'dispatch-project-registration-unavailable' &&
      record?.repositoryPreparation?.checkout
    ) {
      const item = intake.records.find((entry) => entry.id === record.intakeId);
      lines.push(
        `  **Project name:** ${text(item?.repository.name ?? 'Repository')}`,
        `  **Folder path:** ${text(record.repositoryPreparation.checkout)}`,
      );
    }
  }
  if (notices.length) lines.push('');
  if (historical.length) {
    lines.push(
      `**Historical reservations:** ${historical.length} unresolved; ${historical.filter(legacyRetiredReservation).length} unknown reservations excluded from active slots under the earlier retirement contract.`,
      'Unknown reservations are not evidence of running agents; verified active work consumes slots. Another creation for the same issue remains fenced until native evidence resolves its reservation.',
      '',
    );
    for (const record of historical.slice(0, 12)) {
      const code = record.capacityObservation?.code ?? 'dispatch-capacity-observation-required';
      lines.push(
        `- **Issue:** ${issueLabel(record.intakeId)}`,
        `  **Diagnostic:** \`${code}\``,
        `  **Action:** ${workflowRecovery(code)?.next ?? 'Inspect the native creation receipt and source history. Missing or unreadable evidence does not establish inactivity. The owning intake can retry action:reconcile with this retained id.'}`,
      );
    }
    lines.push('');
  }
  if (!started.length && !sent.length && !notices.length && !historical.length && !recovered)
    lines.push(pending ? 'Accepted assignments are waiting to start.' : quiet.message, '');
  const queuedOwners = new Set(queuedFeedback.map(({ record }) => record.id)).size;
  lines.push(
    `**Active:** ${managing.length} issues · **Pending:** ${pending}`,
    `**Queued feedback:** ${queuedFeedback.length} item${queuedFeedback.length === 1 ? '' : 's'} across ${queuedOwners} issue${queuedOwners === 1 ? '' : 's'}`,
    `**Retirement pending:** ${retirementPending}`,
    `**Slots:** ${occupied}/${input.slots} occupied`,
  );
  if (pending && !notices.length)
    lines.push(
      occupied >= input.slots
        ? 'Pending issues will start when a slot becomes available.'
        : 'Intake will continue pending assignments on the next check.',
    );
  return {
    response: codexHeartbeatEnvelope(
      input.automationId,
      [githubNotificationQuote(lines.join('\n')), discovery].filter(Boolean).join('\n\n'),
      Boolean(discovery) ||
        started.length > 0 ||
        sent.length > 0 ||
        recovered ||
        (Boolean(health) && health !== state.intakeHealth),
    ),
    health,
    sent: sent.map(({ event }) => event.id),
    started: started.map((record) => record.id),
  };
}
