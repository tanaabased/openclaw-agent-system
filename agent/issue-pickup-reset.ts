import { pickupRecord, type PickupManagedRecord } from './issue-pickup-capacity.ts';
import discardPickupSelection from './issue-pickup-discard-selection.ts';
import type { IssuePickupState } from './issue-pickup-state.ts';

/** retain external-write evidence, not cached discovery or handoffs already owned by intake. */
export default function resetIssuePickup(
  pickup: IssuePickupState | undefined,
  records: PickupManagedRecord[],
) {
  if (!pickup) return;
  const retained = structuredClone(pickup);
  retained.operations = retained.operations.filter(
    (operation) =>
      (operation.attemptedAt !== undefined || operation.receipt) &&
      !pickupRecord(records, pickup, operation),
  );
  for (const operation of retained.operations) discardPickupSelection(operation);
  return retained;
}
