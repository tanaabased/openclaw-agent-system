import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { ClaimSource } from './assignment-claim.ts';
import { automationHash } from './automation-hash.ts';

/** all participants use the same issue history boundary, independent of their native window. */
export function pickupClaimSource(
  source: Omit<ClaimSource, 'assignmentEventId' | 'assignerNodeId' | 'pickup'>,
  previousEventId: string | null,
  assignmentEventId?: string,
): ClaimSource {
  return {
    ...source,
    assignmentEventId: `pickup:${automationHash(previousEventId)}`,
    assignerNodeId: source.receivingNodeId,
    pickup: { previousEventId, ...(assignmentEventId ? { assignmentEventId } : {}) },
  };
}

export default function assignmentClaimSource(intake: IntakeRecord) {
  return {
    owner: intake.repository.owner.login,
    repository: intake.repository.name,
    repositoryNodeId: intake.repository.nodeId,
    issueNodeId: intake.issue.nodeId,
    number: intake.issue.number,
    receivingNodeId: intake.receiving.nodeId,
    assignmentEventId: intake.assignment.nodeId,
    assignerNodeId: intake.assignment.actor.nodeId,
  };
}
