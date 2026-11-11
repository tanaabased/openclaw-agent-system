import type { WorkflowStage } from './workflow-stage.ts';

export interface WorkflowScheduleAuthority {
  version: 1;
  workflow: 'issue-assignment' | 'review-request';
  automationId: string;
  sourceThreadId: string;
  policyDigest: string;
  definitionDigest: string;
  capabilities: Array<WorkflowStage | 'publication' | 'feedback'>;
}

/** only a freshly reconciled native definition can authorize a new stage or publication. */
export function requireWorkflowSchedule(
  saved: WorkflowScheduleAuthority | undefined,
  current: Omit<WorkflowScheduleAuthority, 'version' | 'capabilities'>,
  capability: WorkflowStage | 'publication' | 'feedback',
): void {
  if (
    !saved ||
    saved.version !== 1 ||
    !saved.capabilities.includes(capability) ||
    !current.automationId ||
    !current.sourceThreadId ||
    saved.automationId !== current.automationId ||
    saved.workflow !== current.workflow ||
    (capability !== 'publication' &&
      capability !== 'feedback' &&
      (capability === 'review') !== (current.workflow === 'review-request')) ||
    saved.sourceThreadId !== current.sourceThreadId
  )
    throw new Error('workflow-schedule-reconciliation-required');
}
