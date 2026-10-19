import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

/** a busy native owner counts once, including a handed-off operator implementation. */
export function openClawItemOccupied(record: OpenClawDispatchRecord) {
  if (record.retirement && record.nativeInactive !== undefined) return !record.nativeInactive;
  if (record.reset || !record.request) return false;
  return Boolean(
    (!record.handoff &&
      record.phase !== 'complete' &&
      (!['blocked', 'waiting', 'retrying'].includes(record.phase) ||
        !record.sessionCreation?.verified ||
        ((record.assessmentTurn ?? record.firstTurn)?.status !== 'completed' &&
          Boolean(record.assessmentTurn ?? record.firstTurn) &&
          !(record.assessmentTurn ?? record.firstTurn)?.inactive))) ||
    [record.work?.turn, record.work?.deliveryTurn].some(
      (turn) => turn && turn.status !== 'completed' && !turn.inactive,
    ) ||
    record.feedback?.activity?.busy ||
    record.feedback?.events.some(
      (event) =>
        event.turn &&
        event.turn.status !== 'completed' &&
        !event.turn.inactive &&
        (event.phase !== 'blocked' || record.feedback?.activity?.busy !== false),
    ),
  );
}
export default function openClawCapacity(records: OpenClawDispatchRecord[], limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('dispatch-capacity-invalid');
  const occupied = records.filter(openClawItemOccupied).length;
  return { occupied, available: Math.max(0, limit - occupied) };
}
