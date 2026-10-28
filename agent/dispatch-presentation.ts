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
  const decision = JSON.parse(record.routing!) as RoutingDecision;
  return renderAssessmentResult(result, {
    ...presentation,
    issue: {
      label: repository(intake) + '#' + intake.issue.number,
      url: issueUrl(intake),
      kind: managedPullRequest(intake) ? 'Pull request' : 'Issue',
    },
    routing: {
      ...decision,
      model: decision.selection!.model,
      effort: decision.selection!.effort,
    },
    effective: record.effective,
    routingInstructions: record.routingInstructions,
    workspace,
    assessment: record.stageReceipt?.selection ?? record.assessment,
  });
}
