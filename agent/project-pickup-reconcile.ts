import { automationHash } from './automation-hash.ts';
import type { PickupEnrollment } from './project-pickup-enrollment.ts';
import type { ProjectPickupState } from './project-pickup-state.ts';

/** live selection policy owns future work; retained effects keep their original scope. */
export default async function reconcileProjectPickup(
  state: { projectPickup?: ProjectPickupState },
  save: () => Promise<void>,
  record: Pick<PickupEnrollment, 'enrollment' | 'timezone'>,
  commit: () => Promise<void>,
) {
  const previous = state.projectPickup;
  const changed =
    previous &&
    (automationHash(previous.enrollment) !== automationHash(record.enrollment) ||
      previous.timezone !== record.timezone);
  if (changed) {
    state.projectPickup = {
      ...previous,
      enrollment: structuredClone(record.enrollment),
      timezone: record.timezone,
      operations: previous.operations
        .filter((operation) => operation.attemptedAt !== undefined || operation.receipt)
        .map((operation) => ({
          ...operation,
          enrollment: operation.enrollment ?? structuredClone(previous.enrollment),
        })),
    };
    // save original effect ownership before publishing the replacement enrollment.
    await save();
  }
  await commit();
}
