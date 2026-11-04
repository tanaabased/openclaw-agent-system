import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import repositoryScope from '../channels/github/repository-scope.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import type { ManagedIssue } from './managed-issue.ts';
/** ordinary intake owns placement through the current shared routing policy. */
export function assignmentClaimRoute(policy: GitHubNotificationPolicy, intake: ManagedIssue) {
  return repositoryScope(policy, intake.repository, 'issue-assignment');
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
