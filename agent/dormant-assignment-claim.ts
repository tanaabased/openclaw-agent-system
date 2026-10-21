import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { assignmentClaimKey } from './assignment-claim.ts';
import assignmentClaimSource from './assignment-claim-source.ts';
import type AssignmentClaimStore from './assignment-claim-store.ts';

/** preserve pilot ownership until an operator resolves it; never elect a replacement owner. */
export default async function assertDormantAssignmentUnclaimed(
  store: AssignmentClaimStore | undefined,
  intake: IntakeRecord,
) {
  await store?.assertUnclaimed(assignmentClaimKey(assignmentClaimSource(intake)));
}
