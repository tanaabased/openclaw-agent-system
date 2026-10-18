import workflowStatus from './workflow-status.ts';
import discoveryNotice from './discovery-notice.ts';
import codexCapacity from './codex-capacity.ts';
import { automationHash } from './automation-hash.ts';
import codexHeartbeat, { codexHeartbeatEnvelope } from './codex-heartbeat.ts';
import codexIssueNotice from './codex-issue-notice.ts';
import pendingDispatchAssignments from './dispatch-pending.ts';
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
  const active = state.records.filter((record) => !record.retired && !record.reset);
  const managing = active.filter((record) => record.effective && record.threadId);
  const occupied = codexCapacity(state.records, input.slots).occupied;
  const pending = pendingDispatchAssignments(state, intake).length;
  const feedback = active.flatMap((record) =>
    (record.feedback?.events ?? []).map((event) => ({ record, event })),
  );
  const sent = feedback.filter(({ event }) => event.attempt?.turnId && !event.reported);
  const queuedFeedback = feedback.filter(({ event }) => event.phase === 'queued');
  const feedbackProblems = active.filter(
    (record) =>
      record.feedback?.code &&
      (record.feedback.code !== 'dispatch-assignment-authority-revoked' ||
        record.feedback.events.some((event) =>
          ['queued', 'prepared', 'running', 'responded'].includes(event.phase),
        )),
  );

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
    ...(intake.blocker ? [{ id: 'scan', code: intake.blocker.code }] : []),
    ...feedbackProblems.map((record) => ({ id: record.id, code: record.feedback!.code! })),
    ...problems.map((record) => ({
      id: record.id,
      code: record.result!.outcome === 'operator-setup-blocker' ? record.result!.code : '',
    })),
  ];
  const health = failures.length ? automationHash(failures) : '';
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
  const title = notices.length
    ? severity === 'error'
      ? '❌ Intake could not finish'
      : '⚠️ Intake needs attention'
    : started.length
      ? `ℹ️ Intake complete — ${started.length} issue${started.length === 1 ? '' : 's'} started${sent.length ? ` · ${sent.length} feedback delivered to chats` : ''}`
      : sent.length
        ? `ℹ️ Intake complete — ${sent.length} feedback item${sent.length === 1 ? '' : 's'} delivered to chats`
        : recovered
          ? 'ℹ️ Intake resumed'
          : pending
            ? `ℹ️ Intake checked — ${pending} issue${pending === 1 ? '' : 's'} pending`
            : 'ℹ️ Intake checked';
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
    lines.push(
      `- **${record ? 'Issue: ' + issueLabel(record.intakeId) : 'Intake'}:** ${notice.summary}`,
      `  **Action:** ${record?.result?.outcome === 'operator-setup-blocker' ? text(record.result.remediation) : notice.next}`,
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
  if (!started.length && !sent.length && !notices.length && !recovered)
    lines.push(pending ? 'Accepted assignments are waiting to start.' : quiet.message, '');
  const queuedOwners = new Set(queuedFeedback.map(({ record }) => record.id)).size;
  lines.push(
    `**Managing:** ${managing.length} issues · **Pending:** ${pending}`,
    `**Queued feedback:** ${queuedFeedback.length} item${queuedFeedback.length === 1 ? '' : 's'} across ${queuedOwners} issue${queuedOwners === 1 ? '' : 's'}`,
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
