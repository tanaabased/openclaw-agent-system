import { automationHash } from './automation-hash.ts';
import type { PickupEnrollment } from './issue-pickup-enrollment.ts';
import type { IssuePickupState } from './issue-pickup-state.ts';

/** live selection policy owns future work; retained effects keep their original scope. */
export default async function reconcileIssuePickup(
  state: { issuePickup?: IssuePickupState },
  save: () => Promise<void>,
  record: Pick<PickupEnrollment, 'enrollment' | 'timezone'>,
  commit: () => Promise<void>,
) {
  const previous = state.issuePickup;
  const changed =
    previous &&
    (automationHash(previous.enrollment) !== automationHash(record.enrollment) ||
      previous.timezone !== record.timezone);
  if (changed) {
    state.issuePickup = {
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
