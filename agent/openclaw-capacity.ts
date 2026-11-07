import issuePickupCapacity from './issue-pickup-capacity.ts';
import type { IssuePickupState } from './issue-pickup-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

/** a busy native owner counts once, including a handed-off operator implementation. */
export function openClawItemOccupied(record: OpenClawDispatchRecord) {
  if (record.retired && record.retirement?.sessionUnavailableObserved) return false;
  if (record.supersededBy || record.reset || !record.request) return false;
  const turns = [
    record.firstTurn,
    record.assessmentTurn,
    record.summaryRecovery?.turn,
    record.decisionTurn,
    record.work?.turn,
    record.work?.deliveryTurn,
    ...(record.feedback?.events.map((event) => event.turn) ?? []),
  ];
  if (record.retired && record.nativeInactive === true) return false;
  return Boolean(
    !record.sessionCreation?.verified ||
    turns.some((turn) => turn?.status === 'attempted' && !turn.inactive) ||
    record.nativeInactive !== true,
  );
}
export default function openClawCapacity(
  records: OpenClawDispatchRecord[],
  limit: number,
  pickup?: IssuePickupState,
  excludeIssue?: string,
) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('dispatch-capacity-invalid');
  const occupied =
    records.filter(openClawItemOccupied).length + issuePickupCapacity(pickup, excludeIssue);
  return { occupied, available: Math.max(0, limit - occupied) };
}
