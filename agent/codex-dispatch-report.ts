import dispatchCreationStatus from './dispatch-creation-status.ts';
import {
  githubNotificationQuote,
  githubNotificationMarkdownCode as inlineCode,
  githubNotificationMarkdownText as text,
} from '../channels/github/presentation/card.ts';
import intakeAutomationNotice from '../channels/github/presentation/intake-automation-notice.ts';
import providerErrorMessage from '../utils/provider-error-message.ts';
import { awaitingReassignment } from './assignment-retirement.ts';
import { automationHash } from './automation-hash.ts';
import codexCapacity from './codex-capacity.ts';
import { denialRecovery } from './codex-dispatch-denial.ts';
import type { DispatchState } from './codex-dispatch-state.ts';
import codexFeedbackProblem from './codex-feedback-problem.ts';
import codexHeartbeat, { codexHeartbeatEnvelope } from './codex-heartbeat.ts';
import codexIssueNotice from './codex-issue-notice.ts';
import discoveryNotice from './discovery-notice.ts';
import dispatchBlocker from './dispatch-blocker.ts';
import pendingDispatchAssignments from './dispatch-pending.ts';
import { dispatchStorageNotice } from './dispatch-storage.ts';
import { dispatchAdmission, type ManagedIssueState as IntakeState } from './managed-issue.ts';
import retirementNotice from './retirement-notice.ts';
import workflowStatus from './workflow-status.ts';
/** summarize intake facts only; assessment results never become intake announcements. */
export default function prepareDispatchReport(input: {
  state: DispatchState;
  intake: IntakeState;
  slots: number;
  debug?: boolean;
  automationId: string;
  currentTimeIso: string;
}) {
  const { state, intake } = input;
  const storage = dispatchStorageNotice(state);
  const discovery = discoveryNotice(state.discoveryProgress);
  const active = state.records.filter((record) => !record.retirement && !record.reset);
  const retiring = state.records.filter(
    (record) => record.retirement && !awaitingReassignment(record),
  );
  const retained = state.records.filter(awaitingReassignment);
  const retirementProblems = state.records.filter(
    (record) =>
      !awaitingReassignment(record) &&
      record.retirement?.code &&
      (record.retirement.eligibleAt ?? 0) <= Date.parse(input.currentTimeIso) &&
      ![
        'retirement-awaiting-reactivation',
        'retirement-native-inventory-required',
        'retirement-native-archive-pending',
      ].includes(record.retirement.code),
  );
  const managing = active.filter((record) => record.effective && record.threadId);
  const occupied = codexCapacity(state.records, input.slots, state.projectPickup).occupied;
  const pending = pendingDispatchAssignments(state, intake).length;
  const feedback = active.flatMap((record) =>
    (record.feedback?.events ?? []).map((event) => ({ record, event })),
  );
  const queuedFeedback = feedback.filter(({ event }) =>
    ['queued', 'prepared', 'running'].includes(event.phase),
  );
  const feedbackProblems = active.filter(codexFeedbackProblem);
  const started = managing
    .filter((record) => record.dispatchedAt !== undefined && record.intakeReportedAt === undefined)
    .slice(0, 12);
  const problems = active.filter(
    (record) =>
      !record.effective &&
      ['blocked', 'waiting', 'retrying'].includes(dispatchCreationStatus(record)) &&
      Boolean(dispatchBlocker(record)),
  );
  const observations = [
    ...(intake.blocker
      ? [
          {
            id: 'scan',
            code: intake.blocker.code,
            operation: 'assignment scan',
            providerDiagnostic: intake.blocker.providerDiagnostic,
          },
        ]
      : []),
    ...(intake.deferred ?? []).map((entry) => {
      const candidate = JSON.parse(entry.candidate) as {
        repositoryPath: string;
        number: number;
      };
      return {
        id: 'deferred-' + entry.key,
        code: entry.code,
        providerDiagnostic: entry.providerDiagnostic,
        operation:
          'assignment scan for ' +
          text(candidate.repositoryPath.replace('/repos/', '') + '#' + candidate.number),
      };
    }),
    ...feedbackProblems.map((record) => ({
      id: record.id,
      code: record.feedback!.code!,
      operation: 'feedback',
    })),
    ...feedback
      .filter(({ event }) => event.code && event.phase !== 'delivered')
      .map(({ record, event }) => ({
        id: record.id + ':' + event.id,
        code: event.code!,
        operation: 'feedback delivery',
      })),
    ...retirementProblems.map((record) => ({
      id: record.id,
      code: record.retirement!.code!,
      operation: 'retirement cleanup',
      diagnostic: record.retirement?.diagnostic,
    })),
    ...problems.map((record) => ({
      id: record.id,
      operation:
        record.denial?.operation === 'create' ? 'native chat creation' : 'assignment preparation',
      denial: record.denial,
      code: dispatchBlocker(record) ?? '',
    })),
  ];
  const notices = observations.map((failure) => ({
    ...failure,
    ...codexIssueNotice({
      event: 'failure',
      code: failure.code,
      providerDiagnostic: 'providerDiagnostic' in failure ? failure.providerDiagnostic : undefined,
      changed: false,
    }),
    ...(failure.code.startsWith('retirement-')
      ? retirementNotice(
          failure.code,
          'diagnostic' in failure && typeof failure.diagnostic === 'string'
            ? failure.diagnostic
            : undefined,
        )
      : {}),
    ...(failure.id.startsWith('deferred-')
      ? {
          severity: 'warning' as const,
          summary: 'This assignment could not be checked. Unrelated intake continues.',
          next: 'A later scan will retry this assignment. Preserve the retained issue and check its diagnostic if the problem persists.',
        }
      : {}),
  }));
  // Pending native cleanup is progress, not an intake failure or later recovery.
  const failures = observations.filter(
    (entry, index) => !entry.code.startsWith('retirement-') || notices[index]!.severity !== 'info',
  );
  const health =
    failures.length || storage.level !== 'normal'
      ? automationHash({
          failures,
          ...(storage.level !== 'normal' ? { storage: storage.key } : {}),
        })
      : '';
  const recovered = !health && Boolean(state.intakeHealth);
  const severity = notices.some((notice) => notice.severity === 'error')
    ? 'error'
    : notices.some((notice) => notice.severity === 'warning')
      ? 'warning'
      : 'info';
  const issueLabel = (intakeId: string | undefined) => {
    const item =
      intake.records.find((entry) => entry.id === intakeId) ??
      (intakeId
        ? state.records.find((entry) => entry.manualIssue?.id === intakeId)?.manualIssue
        : undefined);
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
      : notices.length && severity !== 'info'
        ? !intake.blocker
          ? '⚠️ Intake checked — some items need attention'
          : severity === 'error'
            ? '❌ Intake could not finish'
            : '⚠️ Intake needs attention'
        : started.length
          ? `📥 Intake complete — ${started.length} issue${started.length === 1 ? '' : 's'} started`
          : recovered
            ? '📥 Intake resumed'
            : notices.length
              ? '📥 Intake checked — retirement in progress'
              : pending
                ? `📥 Intake checked — ${pending} issue${pending === 1 ? '' : 's'} pending`
                : '📥 Intake checked';
  const lines = ['## ' + title, ''];
  if (storage.level !== 'normal' || recovered)
    lines.push(
      storage.message,
      storage.level === 'normal'
        ? 'Journal pressure is clear.'
        : 'Complete pending native cleanup. New admissions pause at 32 MiB; existing tasks can continue within the emergency budget.',
      '',
    );
  if (recovered) lines.push('The earlier intake problem has cleared.', '');
  for (const record of started)
    lines.push(
      `- **Issue:** [${issueLabel(record.intakeId ?? record.manualIssue?.id)}](codex://threads/${encodeURIComponent(record.threadId!)})`,
    );
  if (started.length) lines.push('');
  for (const notice of notices.slice(0, 12)) {
    const record = state.records.find((entry) => entry.id === notice.id);
    if (notice.id === 'scan' && intakeAutomationNotice(notice.code)) {
      lines.push(
        `- **What happened:** ${notice.summary}`,
        `- **Next step:** ${notice.next}`,
        `- **Technical detail:** ${inlineCode(notice.code)}`,
      );
      continue;
    }
    lines.push(
      `- **${record ? 'Issue: ' + issueLabel(record.intakeId ?? record.manualIssue?.id) : 'Intake'}:** ${notice.summary}`,
      `  **Operation:** ${notice.operation}`,
      `  **${notice.severity === 'info' ? 'Next step' : 'Action'}:** ${record?.denial ? 'This action remains held; unrelated eligible intake can continue.' : notice.next}`,
      ...(record ? [`  **Status:** ${workflowStatus(record)}`] : []),
      ...(record?.denial
        ? [
            `  **Denied action:** ${inlineCode(record.denial.operation === 'prepare' ? 'dispatch:prepare' : 'create_thread')}`,
            `  **Reason:** ${text(providerErrorMessage(record.denial.reason) ?? 'Unavailable in native evidence.')}`,
            `  **Recovery:** ${denialRecovery} Retained id: ${inlineCode(notice.id)}; denied call: ${inlineCode(record.denial.callId)}.`,
          ]
        : []),
      `  **Diagnostic:** ${inlineCode(notice.code)}`,
    );
    if (
      notice.code === 'dispatch-project-registration-unavailable' &&
      record?.repositoryPreparation?.checkout
    ) {
      const item = dispatchAdmission(record, intake.records ?? []);
      lines.push(
        `  **Project name:** ${item ? inlineCode(item.repository.name) : 'Repository'}`,
        `  **Folder path:** ${inlineCode(record.repositoryPreparation.checkout)}`,
      );
    }
  }
  if (notices.length) lines.push('');
  if (!started.length && !notices.length && !recovered)
    lines.push(pending ? 'Accepted assignments are waiting to start.' : quiet.message, '');
  const queuedOwners = new Set(queuedFeedback.map(({ record }) => record.id)).size;
  lines.push(
    `**Active:** ${managing.length} issues · **Pending:** ${pending}`,
    `**Queued feedback:** ${queuedFeedback.length} item${queuedFeedback.length === 1 ? '' : 's'} across ${queuedOwners} issue${queuedOwners === 1 ? '' : 's'}`,
    `**Retirement pending:** ${retiring.length}`,
    `**Awaiting reassignment:** ${retained.length}`,
    `**Slots:** ${occupied}/${input.slots} occupied`,
  );
  if (pending && !notices.length)
    lines.push(
      occupied >= input.slots
        ? 'Pending issues will start when a slot becomes available.'
        : 'Intake will continue pending assignments on the next check.',
    );
  const operational = [githubNotificationQuote(lines.join('\n')), discovery]
    .filter(Boolean)
    .join('\n\n');
  const notify =
    Boolean(discovery) ||
    started.length > 0 ||
    recovered ||
    (Boolean(health) && health !== state.intakeHealth);
  return {
    response: codexHeartbeatEnvelope(input.automationId, operational, notify),
    health,
    started: started.map((record) => record.id),
  };
}
