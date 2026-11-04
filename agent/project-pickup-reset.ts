import { pickupRecord, type PickupManagedRecord } from './project-pickup-capacity.ts';
import discardPickupSelection from './project-pickup-discard-selection.ts';
import type { ProjectPickupState } from './project-pickup-state.ts';

/** retain external-write evidence, not cached discovery or handoffs already owned by intake. */
export default function resetProjectPickup(
  pickup: ProjectPickupState | undefined,
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
