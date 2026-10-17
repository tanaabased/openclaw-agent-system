import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

/** a busy native owner counts once, including a handed-off operator implementation. */
export function openClawItemOccupied(record: OpenClawDispatchRecord) {
  if (record.retired || record.reset || !record.request) return false;
  return Boolean(
    (!record.handoff &&
      record.phase !== 'complete' &&
      (record.phase !== 'blocked' ||
        !record.sessionCreation?.verified ||
        ((record.assessmentTurn ?? record.firstTurn)?.status !== 'completed' &&
          Boolean(record.assessmentTurn ?? record.firstTurn) &&
          !/cancelled|failed|revoked|policy-changed/.test(record.blocker ?? '')))) ||
    record.feedback?.activity?.busy ||
    record.feedback?.events.some(
      (event) => event.phase !== 'blocked' && event.turn && event.turn.status !== 'completed',
    ),
  );
}
export default function openClawCapacity(records: OpenClawDispatchRecord[], limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('dispatch-capacity-invalid');
  const occupied = records.filter(openClawItemOccupied).length;
  return { occupied, available: Math.max(0, limit - occupied) };
}
