import { Value } from 'typebox/value';

import renderAssessmentResult from '../channels/github/presentation/assessment-result.ts';
import { directAssessmentRequestSchema } from '../tools/dispatch/assessment-schema.ts';
import { parseAssessmentSubmission } from './assessment-result.ts';
import { replyLocator } from './reply-target.ts';

/** Pure presentation: the native tool exchange owns the full source, not a task journal. */
export default function renderNativeAssessment(input: unknown) {
  if (
    !Value.Check(directAssessmentRequestSchema, input) ||
    input.operation !== 'render' ||
    !input.target ||
    input.includeDetails
  )
    throw new Error('assessment-render-request-invalid');
  const target = replyLocator(input.target);
  if (target.kind) throw new Error('assessment-render-target-invalid');
  const assessment = parseAssessmentSubmission(input.result);
  if (!assessment.reviewSummary?.trim()) throw new Error('assessment-review-summary-required');
  return {
    status: 'formatted' as const,
    retained: false as const,
    presentation: renderAssessmentResult(assessment, {
      issue: {
        label: `${target.owner}/${target.name}#${target.number}`,
        url: input.target,
        kind: target.itemType === 'pull-request' ? 'Pull request' : 'Issue',
      },
      retained: false,
      assessmentOnly: input.assessmentOnly,
    }),
    instructions:
      'The complete assessment was submitted in this native tool call and is not repeated in the response; Agent System has not saved it. Show only presentation as the visible assessment reply. Continue from native conversation and current user direction; do not record or reinject this assessment. Formatting grants no implementation or publication authority. Publish the concise review through Task Update only within its existing authorization.',
  };
}

export function assessmentPresentationRequest(target: string, assessmentOnly = false) {
  return {
    action: 'assessment' as const,
    operation: 'render' as const,
    target,
    ...(assessmentOnly ? { assessmentOnly } : {}),
  };
}
