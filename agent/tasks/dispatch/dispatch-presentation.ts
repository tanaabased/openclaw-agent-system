import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { RoutingDecision } from '../../model-routing.ts';

import type { WorkflowInstructionsPresentation } from '../../../channels/github/presentation/workflow-instructions.ts';

export function dispatchAssessmentContext(
  record: Pick<
    SharedDispatchRecord,
    'routing' | 'effective' | 'routingInstructions' | 'assessment' | 'manualIssue'
  >,
  workspace: string,
  presentation: WorkflowInstructionsPresentation & { routingManifestPath?: string } = {},
) {
  let decision: RoutingDecision | undefined;
  try {
    decision = record.routing ? JSON.parse(record.routing) : undefined;
  } catch {
    // optional display metadata never invalidates native ownership or the assessment.
  }
  return {
    ...presentation,
    workflow: presentation.workflow && {
      ...presentation.workflow,
      assessment: {
        ...presentation.workflow.assessment,
        ...record.manualIssue?.selections?.assessment,
      },
      implementation: {
        ...presentation.workflow.implementation,
        ...record.manualIssue?.selections?.implementation,
      },
    },
    routing: decision?.selection ? { ...decision, ...decision.selection } : undefined,
    effective: record.effective,
    routingInstructions: record.routingInstructions,
    workspace,
    assessment: record.assessment,
  };
}
