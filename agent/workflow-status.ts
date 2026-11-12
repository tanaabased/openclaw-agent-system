import dispatchCreationStatus from './dispatch-creation-status.ts';
import { awaitingReassignment } from './tasks/retirement/assignment-retirement.ts';
export interface IssueWorkflowState {
  request?: unknown;
  effective?: unknown;
  threadId?: string;
  nativeInactive?: boolean;
  capacityObservation?: {
    code: string;
  };
  retirement?: {
    reason?: string;
    operatorRequest?: unknown;
  };
  reset?: unknown;
  supersededBy?: string;
  blocker?: string;
  retry?: { code: string; attempts: number };
}
/** report native activity and resource custody; old results never select a conversation phase. */
export default function workflowStatus(record: IssueWorkflowState) {
  if (record.supersededBy) return 'superseded';
  if (awaitingReassignment(record)) return 'awaiting-reassignment';
  if (record.retirement) return 'retirement-pending';
  if (record.reset) return 'obsolete';
  if (record.nativeInactive === true) return 'idle';
  if (
    record.nativeInactive === false ||
    record.capacityObservation?.code === 'dispatch-capacity-native-active'
  )
    return 'active';
  if (record.threadId) return 'native-unobserved';
  return dispatchCreationStatus(record);
}
