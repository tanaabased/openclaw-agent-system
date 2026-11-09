import { awaitingReassignment } from './assignment-retirement.ts';

interface Delivery {
  adopted?: unknown;
  binding?: { branch: string };
  pullRequest?: { pullRequestNumber: number };
  reconciled?: boolean;
  pushedHead?: string;
}
export interface IssueWorkflowState {
  phase: string;
  threadId?: string;
  nativeInactive?: boolean;
  capacityObservation?: { code: string };
  retired?: unknown;
  retirement?: { reason?: string; operatorRequest?: unknown };
  reset?: unknown;
  supersededBy?: string;
  handoff?: unknown;
  blocker?: string;
  implementationPreparationError?: string;
  retry?: unknown;
  result?: { code?: string; outcome?: string };
  progression?: { stage: string; workOwner?: string };
  implementationDelivered?: true;
  autoDecision?: { ended?: boolean; code?: string };
  decisionTurn?: { status: string; inactive?: boolean };
  delivery?: Delivery;
  feedback?: {
    events: Array<{
      id?: string;
      phase: string;
      retry?: unknown;
      work?: { head?: string; result?: { outcome: string } };
      workDelivery?: Delivery;
    }>;
  };
  continuation?: {
    scope?: 'local' | 'pull-request';
    message?: string;
    phase?: string;
    code?: string;
    retry?: unknown;
    policyHeld?: string;
    result?: { outcome: string };
    resultHistory?: Array<{ result: { outcome: string } }>;
    head?: string;
  };
  work?: {
    scope?: 'local' | 'pull-request';
    delivery?: Delivery;
    result?: { outcome: string };
    resultHistory?: Array<{ result: { outcome: string } }>;
    code?: string;
    turn?: { status: string };
    implementation?: unknown;
    caller?: { runId: string };
    clarificationInput?: { runId: string };
  };
}

/** report native activity and resource custody; old results never select a conversation phase. */
export default function workflowStatus(record: IssueWorkflowState) {
  if (record.supersededBy) return 'superseded';
  if (awaitingReassignment(record)) return 'awaiting-reassignment';
  if (record.retirement) return record.retired ? 'retired' : 'retirement-pending';
  if (record.retired || record.reset) return 'obsolete';
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
