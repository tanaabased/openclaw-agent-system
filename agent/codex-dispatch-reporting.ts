import {
  dispatchAdmission,
  managedIssueState,
  type ManagedIssue as IntakeRecord,
  type ManagedIssueState as IntakeState,
} from './managed-issue.ts';
import { type default as IntakeRecordStore } from '../channels/github/intake/record-store.ts';

import { githubNotificationMarkdownCode as inlineCode } from '../channels/github/presentation/card.ts';
import { RepositoryPreparationError } from '../tools/git/repository-service.ts';
import { type AssessmentResult } from './assessment-result.ts';
import requireDispatchCheck from './codex-dispatch-check.ts';
import {
  code,
  issueUrl,
  repository,
  type CodexDispatchTransaction,
} from './codex-dispatch-context.ts';
import intakeDebug from './intake-debug.ts';
import prepareDispatchReport from './codex-dispatch-report.ts';
import { type DispatchState, type DispatchRecord } from './codex-dispatch-state.ts';

import codexHostAccess from './codex-host-access.ts';
import codexIssueNotice from './codex-issue-notice.ts';
import {
  dispatchFailurePhase,
  dispatchRecheckable,
  scheduleDispatchRetry,
} from './dispatch-retry.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import workflowFailure from './workflow-failure.ts';
import workflowRecovery from './workflow-recovery.ts';
import workflowStatus from './workflow-status.ts';

export default async function reportDispatch(
  input: Record<string, unknown>,
  context: {
    state: DispatchState;
    admitted: IntakeState;
    intakeStore: IntakeRecordStore;
    now: number;
    slots: number;
    debug?: boolean;
    save(): Promise<void>;
  },
) {
  const { state, intakeStore, now, save, slots } = context;
  if (
    Object.keys(input).some((key) => !['automationId', 'currentTimeIso'].includes(key)) ||
    typeof input.automationId !== 'string' ||
    typeof input.currentTimeIso !== 'string'
  )
    throw new Error('dispatch-request-invalid');
  const run = state.run;
  if (!run) throw new Error('dispatch-native-occurrence-unavailable');
  if (input.automationId !== run.automationId || input.currentTimeIso !== run.currentTimeIso)
    return {
      status: 'continue',
      nextAction: 'report',
      request: {
        action: 'report',
        automationId: run.automationId,
        currentTimeIso: run.currentTimeIso,
      },
      instruction: 'Call report with this scheduled occurrence; do not finish yet.',
    };
  const present = (response: string) => {
    const diagnostic = intakeDebug(context.debug, state.records, (record) => {
      const item = dispatchAdmission(record, context.admitted.records ?? []);
      return item ? repository(item) + '#' + item.issue.number : 'Issue';
    });
    return diagnostic
      ? response.replace(
          /<\/message>\n<\/heartbeat>$/u,
          () => '\n\n' + diagnostic + '</message>\n</heartbeat>',
        )
      : response;
  };
  if (run.response && run.reportVersion === 1)
    return { status: 'report', response: present(run.response) };
  const occurrence = Date.parse(input.currentTimeIso);
  if (!Number.isFinite(occurrence)) throw new Error('heartbeat-request-invalid');
  const scan = await intakeStore.read();
  if (!scan) throw new Error('dispatch-intake-record-missing');
  if ((scan.lastAttemptAt ?? 0) < occurrence && (scan.blocker?.retryAfter ?? 0) <= occurrence)
    throw new Error('dispatch-scan-required');
  if (run.actions < 12 && !run.stopped && !scan.blocker) {
    try {
      requireDispatchCheck(state, managedIssueState(scan, state.records)!, occurrence);
    } catch {
      return {
        status: 'continue',
        nextAction: 'next',
        remainingActions: 12 - run.actions,
        instruction:
          'Finish checking pending assignments with next, prepare, and native creation/reconcile before reporting. Do not wait for assessments or announce their progress.',
      };
    }
  }
  const pendingDiscovery = Boolean(
    scan.discovery ||
    state.discoveryCycleAt ||
    state.records.some(
      (r) =>
        !r.retired &&
        !r.reset &&
        (r.feedback?.discoveryPending || Object.keys(r.feedback?.discovery ?? {}).length),
    ),
  );
  if (pendingDiscovery || state.discoveryProgress)
    state.discoveryProgress = {
      pending: pendingDiscovery,
      sources: state.records.filter((r) => !r.retired && !r.reset && r.threadId).length,
      ...(state.discoveryProgress?.pending === pendingDiscovery
        ? { reported: state.discoveryProgress.reported }
        : {}),
    };
  const report = prepareDispatchReport({
    state,
    intake: scan,
    slots,
    automationId: input.automationId,
    currentTimeIso: input.currentTimeIso,
  });
  for (const record of state.records)
    if (report.started.includes(record.id)) record.intakeReportedAt = now;
  for (const record of state.records)
    for (const event of record.feedback?.events ?? [])
      if (report.sent.includes(event.id)) event.reported = true;
  if (state.discoveryProgress) state.discoveryProgress.reported = state.discoveryProgress.pending;
  state.intakeHealth = report.health;
  state.intakeHealthVersion = 1;
  // this is a report attempt, not proof of delivery; prose never gates new assignments.
  run.response = report.response;
  run.reportVersion = 1;
  await save();
  return { status: 'report', response: present(run.response) };
}
function remediation(value: string) {
  if (value.startsWith('dispatch-denial-'))
    return 'Native refusal history is incomplete, ambiguous, or conflicts with execution evidence. Stop this intake occurrence. Restore access to the original native turn and inspect the retained operation before using exact operator recovery; do not clear tracking, infer non-execution, or retry the denied action.';
  if (value === 'model-routing-metadata-conflict')
    return codexIssueNotice({ event: 'failure', code: value, changed: false }).next;
  const recovery = workflowRecovery(value);
  if (recovery) return recovery.next;
  if (value === 'dispatch-native-receipt-reused')
    return "This native receipt belongs to another assessment, including a retired attempt. Reconcile only the receipt returned by this prepared request's `create_thread` call, or omit `receipt` to recover its actual creation. Do not create again or reuse history.";
  if (value.startsWith('dispatch-assessment-skill-'))
    return 'Check `issue-assignment.assessment.skill` against the enabled Codex skills. Use a qualified `plugin:skill` id to resolve ambiguity, and restore the selected skill if it changed. Retry this retained assignment or resume its existing chat; do not create a replacement chat.';
  if (value.startsWith('dispatch-assessment-guidance-'))
    return 'Correct `issue-assignment.assessment.guidance`: use nonempty text or a readable UTF-8 file within the bound agent workspace, without symlinks, up to 32 KiB. Retry the retained assignment after restoring the guidance; live edits apply without Install.';
  if (value === 'dispatch-configured-project-missing')
    return 'The explicitly configured local repository path is missing. Correct or remove its `git.worktrees.repositories.local` override, keep the repository registered as a saved Codex project, and let the next scheduled occurrence retry this retained assignment.';
  if (value.includes('project'))
    return 'Add the exact repository checkout as one saved Git-backed Codex project, resolve any path or origin conflict, then let the next scheduled occurrence retry this retained assignment.';
  if (value.includes('activation'))
    return 'Authorize Install to reconcile the updated assignment schedule, then verify its saved state. Existing intake consent alone does not authorize dispatch.';
  if (value === 'dispatch-mode-unsupported')
    return 'Set `issue-assignment` mode to `plan`, `work`, or `auto`, then retry with the live manifest. Other modes cannot dispatch issue assessments.';
  if (value.includes('routing') || value.includes('model'))
    return 'Inspect the retained routing evidence and configured profiles. Repair the selection or native model access; do not substitute a model or recreate the chat.';
  if (value.includes('authority') || value.includes('policy') || value.includes('binding'))
    return 'Restore current issue assignment, repository access, and configured authority before retrying. Retain the existing chat and evidence.';
  if (value.includes('result'))
    return 'Inspect the retained issue chat and its failure or interruption. Resume that same chat to finish the assessment and submit its structured result; do not launch a replacement.';
  return 'Inspect this operation and the retained native creation receipt, chat, and worktree. Resolve the reported condition, then reconcile the existing creation; never repeat an uncertain create or change credentials without evidence of an authentication failure.';
}
function blocker(
  record: DispatchRecord,
  value: string,
  error?: unknown,
  repositoryId?: number,
): AssessmentResult {
  const preparation = record.repositoryPreparation;
  const path =
    error instanceof RepositoryPreparationError
      ? error.path
      : (preparation?.checkout ?? preparation?.path);
  const identity =
    preparation?.identity ??
    (error instanceof RepositoryPreparationError ? error.identity : undefined);
  const detail = path
    ? (identity ? ' Repository: ' + inlineCode(identity) + '.' : '') +
      ' Path: ' +
      inlineCode(path) +
      '.'
    : '';
  const action =
    value === 'dispatch-project-registration-unavailable'
      ? 'No supported native project registration action is available. Add this exact checkout as the primary folder of one saved local Codex project, then let the next scheduled occurrence verify it and resume the retained assignment.'
      : value === 'repository-preparation-changed'
        ? 'This assignment or interrupted clone is pinned to its retained repository location. Restore the previous working-directory and roots. For a normal checkout outside the managed roots, you can instead set ' +
          inlineCode(
            'git.worktrees.repositories.local.' +
              (repositoryId === undefined
                ? 'github-<repository-database-id>'
                : 'github-' + repositoryId),
          ) +
          ' to ' +
          inlineCode(JSON.stringify(preparation?.path ?? path)) +
          '. If the base checkout location changed, restore the previous worktree root too. Verify the retained checkout, then let the next scheduled occurrence resume this assignment. New assignments may use a different configured location; do not delete the retained journal or checkout.'
        : value === 'repository-clone-interrupted'
          ? 'Inspect this retained temporary clone. Repair it, or remove only this confirmed preparation-owned temporary directory, then retry; the runtime will not clone over it.'
          : value.startsWith('repository-')
            ? 'Resolve the repository path or identity conflict, or restore access. Use an explicit local repository mapping for same-name repositories. Do not overwrite user work or change storage to bypass the failure.'
            : remediation(value);
  return {
    version: 1,
    outcome: 'operator-setup-blocker',
    code: value,
    summary: 'The issue assessment needs setup or recovery.',
    remediation:
      (workflowRecovery(value, workflowFailure(error, value).providerDiagnostic)?.next ?? action) +
      detail,
    evidence: [{ source: 'Agent System dispatch', status: 'observed', detail: value }],
    progress: record.result?.progress ?? {
      completed: record.threadId ? ['Retained native issue chat ' + record.threadId + '.'] : [],
      remaining: ['Finish assessment in the verified issue worktree.'],
    },
  };
}
export function notice(record: DispatchRecord, intake?: IntakeRecord) {
  const failure =
    !record.effective && record.result?.outcome === 'operator-setup-blocker'
      ? record.result
      : undefined;
  return {
    id: record.id,
    status: record.handoff ? 'handed-off' : record.phase,
    workflowStatus: workflowStatus(record),
    assignmentObservation: record.assignmentObservation,
    assignmentWarning:
      record.assignmentObservation && workflowRecovery(record.assignmentObservation.code),
    changed: Boolean(record.dispatchedAt && !record.intakeReportedAt) || Boolean(failure),
    threadId: record.threadId,
    ...(record.denial ? { denial: record.denial } : {}),
    ...(failure
      ? {
          code: failure.code,
          ...codexIssueNotice({
            event: 'failure',
            changed: true,
            code: failure.code,
            ...(intake
              ? {
                  issue: {
                    label: repository(intake) + '#' + intake.issue.number,
                    url: issueUrl(intake),
                  },
                }
              : {}),
            actionMarkdown: failure.remediation,
            facts:
              failure.code === 'dispatch-project-registration-unavailable' &&
              record.repositoryPreparation?.checkout
                ? [
                    {
                      label: 'Project name',
                      value: intake ? inlineCode(intake.repository.name) : 'Repository',
                    },
                    {
                      label: 'Folder path',
                      value: inlineCode(record.repositoryPreparation.checkout),
                    },
                  ]
                : [],
          }),
        }
      : {}),
    nextAction: 'next',
    instruction: failure
      ? 'Continue next for unrelated eligible assignments, then report this intake obstacle with any issues already started. Do not repeat an uncertain creation.'
      : 'Continue checking pending assignments while this run has capacity. Assessment progress belongs only in the issue.',
  };
}

export async function failDispatch(
  record: DispatchRecord,
  error: unknown,
  tx: Pick<CodexDispatchTransaction, 'state' | 'admitted' | 'now' | 'save'>,
) {
  const { state, admitted, now, save } = tx;

  if (error instanceof WorkflowPolicyHeld)
    return { status: 'policy-held', id: record.id, reason: error.reason, nextAction: 'next' };
  if (['dispatch-policy-disabled', 'dispatch-activation-required'].includes(code(error)))
    throw error;
  const previousCode =
    record.result?.outcome === 'operator-setup-blocker' ? record.result.code : undefined;
  if (codexHostAccess(error) || record.phase === 'complete') throw error;
  // Native worktree setup returns a client receipt before the child is readable.
  if (
    code(error) === 'dispatch-creation-unresolved' &&
    record.phase === 'creating' &&
    record.clientThreadId &&
    !record.threadId &&
    !record.receiptThreadId &&
    now < record.createdAt + 300000
  ) {
    record.retryAfter = record.createdAt + 300000;
    await save();
    return { id: record.id, status: 'creating', changed: false };
  }
  record.result = blocker(
    record,
    code(error),
    error,
    dispatchAdmission(record, admitted.records ?? [])?.repository.databaseId,
  );
  record.retryAfter = now + 300000;
  scheduleDispatchRetry(record, code(error), error, now);
  record.phase = dispatchFailurePhase(record, code(error), error);
  if (
    record.phase === 'retrying' &&
    record.retryAfter &&
    record.result.outcome === 'operator-setup-blocker'
  )
    record.result.remediation = dispatchRecheckable(code(error))
      ? record.result.remediation +
        ' Agent System will recheck at or after ' +
        new Date(record.retryAfter).toISOString() +
        '.'
      : 'Automatic recovery will retry at or after ' +
        new Date(record.retryAfter).toISOString() +
        '. Preserve the retained request; no new stage approval is needed.';
  const shared = ['authentication', 'missing-credential'].includes(
    workflowFailure(error, 'dispatch-operation-failed').providerDiagnostic?.classification ?? '',
  );
  if (state.run) {
    if (shared) state.run.stopped = 'blocked';
    else delete state.run.stopped;
  }
  const result = notice(record, dispatchAdmission(record, admitted.records ?? []));
  Object.assign(result, workflowFailure(error, 'dispatch-operation-failed'));
  if (shared) {
    result.nextAction = 'report';
    result.instruction =
      'Shared authentication is unavailable. Stop this occurrence and report the failure; do not continue unrelated work through another credential or route.';
  }
  result.changed = previousCode !== code(error);
  if ('notify' in result) result.notify = result.changed;
  await save();
  return result;
}
