import { assessmentPresentationRequest } from './assessment-render.ts';
import { assessmentResultContextSchema } from './assessment-result.ts';
import { dispatchAssessmentContext } from './dispatch-presentation.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';

/** carry display inputs through native resumption without storing or requiring a review receipt. */
export default function assessmentReviewContext(
  record: Parameters<typeof dispatchAssessmentContext>[0] &
    Pick<SharedDispatchRecord, 'implementationDecision'>,
  target: string,
  workspace: string,
  presentation: Parameters<typeof dispatchAssessmentContext>[2] = {},
) {
  return {
    assessment: record.assessment,
    resultSchema: assessmentResultContextSchema,
    presentationRequest: assessmentPresentationRequest(
      target,
      false,
      dispatchAssessmentContext({ ...record, stageReceipt: undefined }, workspace, presentation),
    ),
    decision: record.implementationDecision,
    instruction:
      "If the initial assessment or question has not yet been shown in this chat, use the current native assessment and plan to render it with presentationRequest and result matching resultSchema. If startup stopped before assessment, apply the selected assessment body once. Include the current Auto decision when supplied. Show the complete returned review, routing and configured debug cards before the first implementation update, and preserve them in this turn's final response. If the review is already visible, do not repeat it. Do not reload a historical plan, save an assessment, record a presentation receipt, or require another approval; presentation is independent of existing implementation permission.",
  };
}
