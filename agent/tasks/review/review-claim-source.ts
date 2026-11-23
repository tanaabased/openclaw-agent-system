import type { ClaimSource } from '../dispatch/assignment-claim.ts';
import type { ReviewAdmission } from './review-admission.ts';

/** reuse placement and claim receipts with the genuine review-request event identity. */
export default function reviewClaimSource(admission: ReviewAdmission): ClaimSource {
  if (admission.origin.kind !== 'request') throw new Error('review-request-origin-required');
  return {
    kind: 'review-request',
    owner: admission.repository.owner.login,
    repository: admission.repository.name,
    repositoryNodeId: admission.repository.nodeId,
    issueNodeId: admission.issue.nodeId,
    number: admission.issue.number,
    receivingNodeId: admission.receiving.nodeId,
    assignmentEventId: admission.origin.eventId,
    assignerNodeId: admission.origin.requester.nodeId,
  };
}
