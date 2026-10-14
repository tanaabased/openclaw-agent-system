import type { DispatchRecord } from './codex-dispatch-state.ts';

/** a conversation occupies one slot, regardless of its pending comment count. */
export function codexItemOccupied(record: DispatchRecord): boolean {
  if (record.retired || record.reset || !record.request) return false;
  return (
    (!record.handoff &&
      (record.phase === 'creating' ||
        record.phase === 'assessing' ||
        (record.phase === 'blocked' && !record.effective))) ||
    Boolean(
      !record.handoff &&
      record.continuation &&
      ['waiting', 'prepared', 'running', 'delivery'].includes(record.continuation.phase),
    ) ||
    Boolean(
      record.feedback?.events.some((event) =>
        ['prepared', 'running', 'responded'].includes(event.phase),
      ),
    )
  );
}

export default function codexCapacity(records: DispatchRecord[], limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('dispatch-capacity-invalid');
  const occupied = records.filter(codexItemOccupied).length;
  return { occupied, available: Math.max(0, limit - occupied) };
}
