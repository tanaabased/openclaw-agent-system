import { automationHash } from './automation-hash.ts';
import issueWorkflowProgress, { type IssueWorkflowState } from './issue-workflow-progress.ts';
import type { ProjectWork } from './project-pickup-authority.ts';
import {
  pickupUnfinished,
  type PickupOperation,
  type ProjectPickupState,
} from './project-pickup-state.ts';

export type PickupManagedRecord = IssueWorkflowState & {
  issueKey: string;
  projectWork?: ProjectWork;
};

export function pickupIssueKey(pickup: ProjectPickupState, nodeId: string | undefined) {
  return automationHash([
    pickup.enrollment.scope,
    pickup.enrollment.account.nodeId,
    pickup.enrollment.repositoryNodeId,
    nodeId,
  ]);
}

/** transfer a reservation into native custody without charging the same issue twice. */
export default function projectPickupCapacity<R extends PickupManagedRecord>(
  records: R[],
  pickup: ProjectPickupState | undefined,
  occupied: (record: R) => boolean,
  excludeIssue?: string,
) {
  if (!pickup) return 0;
  return pickup.operations.filter((operation) => {
    if (
      !pickupUnfinished(operation) ||
      (excludeIssue && operation.selected?.nodeId === excludeIssue)
    )
      return false;
    const record = pickupRecord(records, pickup, operation);
    return !record || (issueWorkflowProgress(record).action !== 'complete' && !occupied(record));
  }).length;
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
        record.issueKey === pickupIssueKey(pickup, operation.selected?.nodeId) &&
        !record.reset &&
        !record.supersededBy &&
        record.projectWork?.pickup?.assignmentNodeId === operation.receipt!.assignmentNodeId,
    )
  );
}
