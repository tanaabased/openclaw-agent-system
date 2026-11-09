import {
  managedTargetUrl,
  managedPullRequest,
  type ManagedIssue as IntakeRecord,
} from './managed-issue.ts';
import type { AssessmentResult } from './assessment-result.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { RoutingDecision } from './model-routing.ts';

import renderAssessmentResult from '../channels/github/presentation/assessment-result.ts';
import type { WorkflowInstructionsPresentation } from '../channels/github/presentation/workflow-instructions.ts';

function repository(record: IntakeRecord) {
  return record.repository.owner.login + '/' + record.repository.name;
}
function issueUrl(record: IntakeRecord) {
  return managedTargetUrl(record);
}
export default function assessmentPresentation(
  result: AssessmentResult,
  record: SharedDispatchRecord,
  intake: IntakeRecord,
  workspace: string,
  presentation: WorkflowInstructionsPresentation & {
    includeDetails?: boolean;
    routingManifestPath?: string;
  } = {},
) {
  return renderAssessmentResult(result, {
    ...dispatchAssessmentContext(record, workspace, presentation),
    issue: {
      label: repository(intake) + '#' + intake.issue.number,
      url: issueUrl(intake),
      kind: managedPullRequest(intake) ? 'Pull request' : 'Issue',
    },
  });
}

export function dispatchAssessmentContext(
  record: Pick<
    SharedDispatchRecord,
    'routing' | 'effective' | 'routingInstructions' | 'stageReceipt' | 'assessment' | 'manualIssue'
  >,
  workspace: string,
  presentation: WorkflowInstructionsPresentation & { routingManifestPath?: string } = {},
) {
  const decision = record.routing ? (JSON.parse(record.routing) as RoutingDecision) : undefined;
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
    assessment: record.stageReceipt?.selection ?? record.assessment,
  };
}
