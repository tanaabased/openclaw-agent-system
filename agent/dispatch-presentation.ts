import type { AssessmentResult } from './assessment-result.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { RoutingDecision } from './model-routing.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import renderAssessmentResult from '../channels/github/conversation/presentation/assessment-result.ts';
import type { WorkflowInstructionsPresentation } from '../channels/github/conversation/presentation/workflow-instructions.ts';

function repository(record: IntakeRecord) {
  return record.repository.owner.login + '/' + record.repository.name;
}
function issueUrl(record: IntakeRecord) {
  return 'https://github.com/' + repository(record) + '/issues/' + record.issue.number;
}
export default function assessmentPresentation(
  result: AssessmentResult,
  record: SharedDispatchRecord,
  intake: IntakeRecord,
  workspace: string,
  presentation: WorkflowInstructionsPresentation = {},
) {
  const decision = JSON.parse(record.routing!) as RoutingDecision;
  return renderAssessmentResult(result, {
    ...presentation,
    issue: { label: repository(intake) + '#' + intake.issue.number, url: issueUrl(intake) },
    routing: {
      ...decision,
      model: record.effective?.model ?? decision.selection!.model,
      effort: record.effective?.effort ?? decision.selection!.effort,
    },
    effective: record.effective,
    workspace,
    assessment: record.assessment,
  });
}
