import { awaitingReassignment } from './assignment-retirement.ts';
interface Delivery {
  adopted?: unknown;
  binding?: {
    branch: string;
  };
  pullRequest?: {
    pullRequestNumber: number;
  };
  reconciled?: boolean;
  pushedHead?: string;
}
export interface IssueWorkflowState {
  phase: string;
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
  handoff?: unknown;
  blocker?: string;
  implementationPreparationError?: string;
  retry?: unknown;
  progression?: {
    stage: string;
  };
  implementationDelivered?: true;
  delivery?: Delivery;
  feedback?: {
    events: Array<{
      id?: string;
      phase: string;
      retry?: unknown;
    }>;
  };
  work?: {
    scope?: 'local' | 'pull-request';
    delivery?: Delivery;
    code?: string;
    implementation?: unknown;
    caller?: {
      runId: string;
    };
  };
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
  if (record.threadId || ['complete', 'assessing'].includes(record.phase))
    return 'native-unobserved';
  return record.phase;
}
