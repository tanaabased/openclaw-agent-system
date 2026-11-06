import implementationMaterial from './implementation-material.ts';
import { Value } from 'typebox/value';

import renderAssessmentResult, {
  assessmentContextCards,
  type AssessmentPresentationContext,
} from '../channels/github/presentation/assessment-result.ts';
import { directAssessmentRequestSchema } from '../tools/dispatch/assessment-schema.ts';
import { parseAssessmentSubmission } from './assessment-result.ts';
import { replyLocator } from './reply-target.ts';

/** Pure presentation: the native tool exchange owns the full source, not a task journal. */
export default function renderNativeAssessment(
  input: unknown,
  runtime: 'codex' | 'openclaw' = 'codex',
) {
  if (
    !Value.Check(directAssessmentRequestSchema, input) ||
    input.operation !== 'render' ||
    !input.target ||
    input.includeDetails
  )
    throw new Error('assessment-render-request-invalid');
  const target = replyLocator(input.target);
  if (target.kind) throw new Error('assessment-render-target-invalid');
  const submitted = parseAssessmentSubmission(input.result);
  // Compatibility result callers supply the source in their native input; older sources lack
  // the concise review that their adapter derives for the first page.
  const assessment =
    input.material && !submitted.reviewSummary
      ? {
          ...submitted,
          reviewSummary: [
            submitted.summary,
            ...(submitted.outcome === 'clarification-needed'
              ? submitted.questions
              : submitted.outcome === 'operator-setup-blocker'
                ? [submitted.remediation]
                : []),
          ].join('\n\n'),
        }
      : submitted;
  if (!assessment.reviewSummary?.trim()) throw new Error('assessment-review-summary-required');
  return implementationMaterial(
    {
      runtime,
      status: 'formatted' as const,
      retained: false as const,
      presentation: renderAssessmentResult(assessment, {
        issue: {
          label: `${target.owner}/${target.name}#${target.number}`,
          url: input.target,
          kind: target.itemType === 'pull-request' ? 'Pull request' : 'Issue',
        },
        retained: false,
        cards: input.cards,
        assessmentOnly: input.assessmentOnly,
      }),
      instructions:
        'The complete assessment was submitted in this native tool call and is not repeated in the response; Agent System has not saved it. Show only presentation as the visible assessment reply. Continue from native conversation and current user direction; do not record or reinject this assessment. Formatting grants no implementation or publication authority. Publish the concise review through Task Update only within its existing authorization.',
    },
    assessmentPresentationRequest(input.target, input.assessmentOnly),
    input.material,
    {
      purpose: 'assessment-presentation',
      pagedFields: ['presentation'],
      inputFields: ['result', 'cards'],
      instruction:
        'Read every presentation page before displaying the result. Copy only the listed inputFields from the original native tool call into each returned page request. This pure formatter retains no source or plan. Follow next, concatenate text in offset order, parse JSON and restore each path. Show the complete presentation. Page reads do not save a plan or authorize any effect.',
    },
  );
}

export function assessmentPresentationRequest(
  target: string,
  assessmentOnly = false,
  context?: Omit<AssessmentPresentationContext, 'issue'>,
) {
  const cards = context ? assessmentContextCards(context) : [];
  return {
    action: 'assessment' as const,
    operation: 'render' as const,
    target,
    ...(assessmentOnly ? { assessmentOnly } : {}),
    ...(cards.length ? { cards } : {}),
  };
}
