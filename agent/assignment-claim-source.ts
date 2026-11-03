import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import repositoryScope from '../channels/github/repository-scope.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import type { ManagedIssue } from './managed-issue.ts';
import type { ClaimSource } from './assignment-claim.ts';
import { automationHash } from './automation-hash.ts';
import { retainedPickupReceipt } from './project-pickup-authority.ts';

/** new placement applies only until pickup has verified its assignment. */
export function assignmentClaimRoute(policy: GitHubNotificationPolicy, intake: ManagedIssue) {
  const pickup = 'initiation' in intake ? undefined : retainedPickupReceipt(intake);
  if (pickup)
    return {
      decision: pickup.claimCommentId ? ('swarm' as const) : ('local' as const),
      eligibleInstanceIds: undefined,
    };
  return repositoryScope(policy, intake.repository, 'issue-assignment');
}

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
