import type { DispatchRecord } from './codex-dispatch-state.ts';

/** a conversation occupies one slot, regardless of its pending comment count. */
export function codexItemOccupied(record: DispatchRecord): boolean {
  if (record.reset || !record.request) return false;
  return (
    (!record.handoff &&
      !(record.retired && record.nativeInactive) &&
      (record.phase === 'creating' ||
        record.phase === 'assessing' ||
        (['blocked', 'waiting', 'retrying'].includes(record.phase) && !record.nativeInactive))) ||
    Boolean(
      !record.handoff &&
      record.continuation &&
      (['waiting', 'prepared', 'running'].includes(record.continuation.phase) ||
        (['blocked', 'cancelled'].includes(record.continuation.phase) &&
          Boolean(record.continuation.attempt) &&
          !record.nativeInactive) ||
        (record.continuation.phase === 'delivery' &&
          !(record.delivery?.reconciled && record.delivery.pullRequest))),
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

export default function codexCapacity(records: DispatchRecord[], limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('dispatch-capacity-invalid');
  const occupied = records.filter(codexItemOccupied).length;
  return { occupied, available: Math.max(0, limit - occupied) };
}
