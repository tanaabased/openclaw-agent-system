import issueWorkflowProgress from './issue-workflow-progress.ts';
import { feedbackWorkStarted } from './feedback-work.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';

/** unresolved native custody reserves capacity until current native evidence releases it. */
function reserved(record: DispatchRecord): boolean {
  if (record.retirement && record.nativeInactive !== undefined) return !record.nativeInactive;
  if (record.denial) return false;
  if (record.reset || !record.request) return false;
  const progress = issueWorkflowProgress(record);
  const { action } = progress;
  return (
    Boolean(record.summaryRecovery && !record.summaryRecovery.ended && !record.nativeInactive) ||
    Boolean(record.autoDecision && !record.autoDecision.ended && !record.nativeInactive) ||
    (!record.handoff &&
      !(record.retired && record.nativeInactive) &&
      (record.phase === 'creating' ||
        record.phase === 'assessing' ||
        (['blocked', 'waiting', 'retrying'].includes(record.phase) && !record.nativeInactive))) ||
    Boolean(
      !record.handoff &&
      record.continuation &&
      (!feedbackWorkStarted(record) ||
        record.continuation.attempt ||
        record.continuation.binding) &&
      (!record.continuation.policyHeld ||
        record.continuation.attempt ||
        record.continuation.binding) &&
      (action === 'implementation' ||
        (['stopped', 'wait-input'].includes(action) &&
          Boolean(record.continuation.attempt) &&
          !record.nativeInactive) ||
        (action === 'delivery' && progress.publicationPending)),
    ) ||
    Boolean(
      record.feedback?.events.some(
        (event) =>
          ['prepared', 'running', 'responded'].includes(event.phase) ||
          (event.phase === 'blocked' && Boolean(event.attempt) && !record.nativeInactive),
      ),
    )
  );
}

export function codexUnresolvedRetirement(record: DispatchRecord) {
  return Boolean(record.retired && !record.nativeInactive && reserved(record));
}

/** a conversation occupies one slot, regardless of its pending comment count. */
export function codexItemOccupied(record: DispatchRecord): boolean {
  return reserved(record);
}

export default function codexCapacity(records: DispatchRecord[], limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('dispatch-capacity-invalid');
  const occupied = records.filter(codexItemOccupied).length;
  return { occupied, available: Math.max(0, limit - occupied) };
}
