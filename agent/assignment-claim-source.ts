import type { IntakeRecord } from '../channels/github/intake/record-store.ts';

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
