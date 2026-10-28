import { dispatchAdmission, type ManagedIssue as IntakeRecord } from './managed-issue.ts';
import managedOwner from './managed-owner.ts';
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
  const ownership = managedOwner(records, session, (record) => {
    const item = dispatchAdmission(record, admitted);
    if (!item) throw new Error('assessment-managed-admission-missing');
    return (
      `${item.repository.owner.login}/${item.repository.name}`.toLowerCase() ===
        target.repository.toLowerCase() && item.issue.number === target.number
    );
  });
  if (ownership.status === 'ambiguous') throw new Error('assessment-managed-owner-ambiguous');
  const { owner: record, caller } = ownership;
  if (ownership.status === 'historical' || caller?.retired || caller?.reset || caller?.supersededBy)
    throw new Error('assessment-managed-context-invalid');
  if (caller && caller !== record) throw new Error('assessment-managed-target-mismatch');
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
