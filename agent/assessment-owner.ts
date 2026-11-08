import { dispatchAdmission, type ManagedIssue as IntakeRecord } from './managed-issue.ts';
import managedOwner from './managed-owner.ts';
import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';

/** missing, retired, or other-session ownership is never absence of managed work. */
export default function assessmentOwner<
  R extends SharedDispatchRecord & { turnEvidence?: unknown },
>(
  records: R[],
  admitted: IntakeRecord[],
  session: string,
  target: { repository: string; number: number },
) {
  const callers = records.filter((record) => record.threadId === session);
  const current = callers.length === 1 ? callers[0] : undefined;
  const currentAdmission = current && dispatchAdmission(current, admitted);
  const matches = (item: IntakeRecord) =>
    `${item.repository.owner.login}/${item.repository.name}`.toLowerCase() ===
      target.repository.toLowerCase() && item.issue.number === target.number;
  const ownership = managedOwner(records, session, (record) => {
    const item = dispatchAdmission(record, admitted);
    if (!item) {
      if (
        currentAdmission &&
        matches(currentAdmission) &&
        record.threadId !== session &&
        record.issueKey &&
        current?.issueKey &&
        record.issueKey !== current.issueKey
      )
        return false;
      throw new Error('assessment-managed-admission-missing');
    }
    return matches(item);
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
    }),
  };
}
