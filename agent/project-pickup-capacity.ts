import { automationHash } from './automation-hash.ts';
import type { IssueWorkflowState } from './issue-workflow-progress.ts';
import type { ProjectWork } from './project-pickup-authority.ts';
import { type PickupOperation, type ProjectPickupState } from './project-pickup-state.ts';

export type PickupManagedRecord = IssueWorkflowState & {
  issueKey: string;
  projectWork?: ProjectWork;
};

export function pickupIssueKey(
  pickup: ProjectPickupState,
  nodeId: string | undefined,
  repositoryNodeId = pickup.enrollment.repositoryNodeId,
) {
  return automationHash([
    pickup.enrollment.scope,
    pickup.enrollment.account.nodeId,
    repositoryNodeId,
    nodeId,
  ]);
}

/** only an unresolved provider write reserves pickup capacity; intake owns confirmed work. */
export default function projectPickupCapacity(
  pickup: ProjectPickupState | undefined,
  excludeIssue?: string,
) {
  return (pickup?.operations ?? []).filter(
    (operation) =>
      operation.attemptedAt !== undefined &&
      !operation.receipt &&
      (!excludeIssue || operation.selected?.nodeId !== excludeIssue),
  ).length;
}

/** an earlier retired workflow for the same issue cannot take custody of a new assignment. */
export function pickupRecord<R extends PickupManagedRecord>(
  records: R[],
  pickup: ProjectPickupState,
  operation: PickupOperation,
) {
  return (
    operation.receipt &&
    records.find(
      (record) =>
        record.issueKey ===
          pickupIssueKey(
            pickup,
            operation.selected?.nodeId,
            operation.enrollment?.repositoryNodeId,
          ) &&
        !record.reset &&
        !record.supersededBy &&
        record.projectWork?.pickup?.assignmentNodeId === operation.receipt!.assignmentNodeId,
    )
  );
}
