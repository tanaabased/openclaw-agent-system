import { automationHash } from '../../automation-hash.ts';
import type { DispatchState } from './codex-dispatch-state.ts';
import type { ManagedIssueState as IntakeState } from '../managed-issue.ts';
/** Reporting and delivery do not change which assignments the last dispatch check covered. */
export function dispatchCheckDigest(state: DispatchState, intake: IntakeState) {
  return automationHash({
    records: state.records.map((record) => ({
      id: record.id,
      intakeId: record.intakeId,
      manualIssue: record.manualIssue,
      issueKey: record.issueKey,
      sourceThreadId: record.sourceThreadId,
      request: record.request,
      project: record.project,
      threadId: record.threadId,
      clientThreadId: record.clientThreadId,
      receiptThreadId: record.receiptThreadId,
      worktree: record.worktree,
      effective: record.effective,
      retirement: record.retirement,
      reset: record.reset,
      supersededBy: record.supersededBy,
      nativeInactive: record.nativeInactive,
      denial: record.denial,
    })),
    intake: intake.records,
    policy: intake.policyDigest,
  });
}
export default function requireDispatchCheck(
  state: DispatchState,
  intake: IntakeState,
  occurrence: number,
) {
  if (
    !state.checked ||
    state.checked.at < occurrence ||
    state.checked.digest !== dispatchCheckDigest(state, intake)
  )
    throw new Error('dispatch-check-required');
}
