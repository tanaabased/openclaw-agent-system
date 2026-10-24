import { dispatchAdmission, type ManagedIssue as IntakeRecord } from './managed-issue.ts';
import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';

/** missing, inactive, or other-session ownership is never absence of managed work. */
export default function assessmentOwner<
  R extends SharedDispatchRecord & { turnEvidence?: unknown },
>(
  records: R[],
  admitted: IntakeRecord[],
  session: string,
  target: { repository: string; number: number },
) {
  const matching = records.filter((record) => {
    const item = dispatchAdmission(record, admitted);
    if (!item) throw new Error('assessment-managed-admission-missing');
    return (
      `${item.repository.owner.login}/${item.repository.name}`.toLowerCase() ===
        target.repository.toLowerCase() && item.issue.number === target.number
    );
  });
  const callers = records.filter((record) => record.threadId === session);
  if (matching.length > 1 || callers.length > 1)
    throw new Error('assessment-managed-owner-ambiguous');
  const record = matching[0];
  if (callers.length && callers[0] !== record)
    throw new Error('assessment-managed-target-mismatch');
  if (!record) return;
  if (
    record.reset ||
    record.retired ||
    record.retirement ||
    record.nativeInactive ||
    !record.request ||
    record.threadId !== session ||
    !record.worktree ||
    !record.context ||
    !record.assessment
  )
    throw new Error('assessment-managed-context-invalid');
  return {
    record,
    digest: automationHash({
      id: record.id,
      intakeId: record.intakeId,
      manualIssue: record.manualIssue,
      threadId: record.threadId,
      request: record.request,
      worktree: record.worktree,
      context: record.context,
      assessment: record.assessment,
      consumed: record.turnEvidence,
      result: record.result,
      receipt: record.stageReceipt,
      resultTurnId: record.resultTurnId,
      progression: record.progression,
      handoff: record.handoff,
      reset: record.reset,
      retired: record.retired,
      retirement: record.retirement,
      nativeInactive: record.nativeInactive,
    }),
  };
}
