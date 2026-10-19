import type { DispatchRecord } from './codex-dispatch-state.ts';

/** unresolved native custody is independent of whether legacy retirement released a queue slot. */
function reserved(record: DispatchRecord): boolean {
  if (record.retirement && record.nativeInactive !== undefined) return !record.nativeInactive;
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
      (!record.continuation.policyHeld ||
        record.continuation.attempt ||
        record.continuation.binding) &&
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

export function codexUnresolvedRetirement(record: DispatchRecord) {
  return Boolean(record.retired && !record.nativeInactive && reserved(record));
}

/** old retirement released the slot; its unresolved same-issue reservation remains fenced. */
export function legacyRetiredReservation(record: DispatchRecord) {
  return Boolean(
    codexUnresolvedRetirement(record) &&
    !record.reservationVersion &&
    record.capacityObservation?.code !== 'dispatch-capacity-native-active',
  );
}

/** a conversation occupies one slot, regardless of its pending comment count. */
export function codexItemOccupied(record: DispatchRecord): boolean {
  return !legacyRetiredReservation(record) && reserved(record);
}

export default function codexCapacity(records: DispatchRecord[], limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('dispatch-capacity-invalid');
  const occupied = records.filter(codexItemOccupied).length;
  return { occupied, available: Math.max(0, limit - occupied) };
}
