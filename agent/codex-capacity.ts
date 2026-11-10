import type { DispatchRecord } from './codex-dispatch-state.ts';
import issuePickupCapacity from './issue-pickup-capacity.ts';
import type { IssuePickupState } from './issue-pickup-state.ts';
/** unresolved native custody reserves capacity until current native evidence releases it. */
function reserved(record: DispatchRecord): boolean {
  if (record.retirement && record.nativeInactive !== undefined) return !record.nativeInactive;
  if (record.denial) return false;
  if (record.supersededBy || record.reset || !record.request) return false;
  if (record.nativeInactive) return false;
  // An admitted native request reserves a slot until native evidence proves inactivity.
  // Missing plans, replies, cards, and publication receipts do not determine capacity.
  return true;
}
/** a conversation occupies one slot, regardless of its pending comment count. */
export function codexItemOccupied(record: DispatchRecord): boolean {
  return reserved(record);
}
export default function codexCapacity(
  records: DispatchRecord[],
  limit: number,
  pickup?: IssuePickupState,
  excludeIssue?: string,
) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('dispatch-capacity-invalid');
  const occupied =
    records.filter(codexItemOccupied).length + issuePickupCapacity(pickup, excludeIssue);
  return { occupied, available: Math.max(0, limit - occupied) };
}
