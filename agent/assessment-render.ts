import { cardCopyInstructions } from '../channels/github/presentation/card.ts';
import implementationMaterial from './implementation-material.ts';
import { Value } from 'typebox/value';
import { Type } from 'typebox';

import type { WorkflowInstructionsPresentation } from '../channels/github/presentation/workflow-instructions.ts';
import renderAssessmentResult, {
  assessmentContextCards,
  type AssessmentPresentationContext,
} from '../channels/github/presentation/assessment-result.ts';
import { directAssessmentRequestSchema } from '../tools/dispatch/assessment-schema.ts';
import { parseAssessmentSubmission } from './assessment-result.ts';
import { replyLocator } from './reply-target.ts';
import assessmentOwner from './assessment-owner.ts';
import { dispatchAdmission, managedTargetUrl, type ManagedIssue } from './managed-issue.ts';
import { dispatchAssessmentContext } from './dispatch-presentation.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import AssessmentValidationError from './assessment-validation.ts';

const renderRequestSchema = Type.Object(
  {
    ...directAssessmentRequestSchema.properties,
    ...Type.Required(Type.Pick(directAssessmentRequestSchema, ['target'])).properties,
    operation: Type.Literal('render'),
    includeDetails: Type.Optional(Type.Literal(false)),
  },
  { additionalProperties: false },
);

/** resolve display metadata from the bound owner without saving an assessment or advancing work. */
export async function renderBoundAssessment(
  input: unknown,
  context: {
    runtime: 'codex' | 'openclaw';
    records: SharedDispatchRecord[];
    admitted: ManagedIssue[];
    session: string;
    workspace: string;
    debug?: boolean;
    workflow?: WorkflowInstructionsPresentation['workflow'];
  },
) {
  if (input && typeof input === 'object' && !Array.isArray(input) && !('target' in input)) {
    const callers = context.records.filter((record) => record.threadId === context.session);
    if (callers.length > 1) throw new Error('assessment-managed-owner-ambiguous');
    const admitted = callers[0] && dispatchAdmission(callers[0], context.admitted);
    if (admitted) input = { ...input, target: managedTargetUrl(admitted) };
  }
  if (!Value.Check(renderRequestSchema, input))
    throw new AssessmentValidationError(
      'assessment-render-request-invalid',
      renderRequestSchema,
      input,
      'request',
    );
  const target = replyLocator(input.target);
  const owner = assessmentOwner(context.records, context.admitted, context.session, {
    repository: `${target.owner}/${target.name}`,
    number: target.number,
  });
  const record = owner?.record;
  const presentation = {
    workspace: context.workspace,
    debug: context.debug,
    workflow: context.workflow ?? {},
  };
  return renderNativeAssessment(
    input,
    context.runtime,
    record
      ? dispatchAssessmentContext(
          { ...record, assessment: undefined, stageReceipt: undefined },
          context.workspace,
          presentation,
        )
      : presentation,
  );
}

/** Pure presentation: the native tool exchange owns the full source, not a task journal. */
export default function renderNativeAssessment(
  input: unknown,
  runtime: 'codex' | 'openclaw' = 'codex',
  context?: Omit<AssessmentPresentationContext, 'issue'>,
) {
  if (!Value.Check(renderRequestSchema, input))
    throw new AssessmentValidationError(
      'assessment-render-request-invalid',
      renderRequestSchema,
      input,
      'request',
    );
  const target = replyLocator(input.target);
  if (target.kind) throw new Error('assessment-render-target-invalid');
  const submitted = parseAssessmentSubmission(input.result);
  // Complete questions already carry their own concise review; formatting must not hide them.
  // Older paged results also derive a review from their retained source.
  const assessment =
    !submitted.reviewSummary && (input.material || submitted.outcome === 'clarification-needed')
      ? {
          ...submitted,
          reviewSummary: [
            submitted.summary,
            ...(submitted.outcome === 'operator-setup-blocker' ? [submitted.remediation] : []),
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
        cards: context ? assessmentContextCards(context) : undefined,
        assessmentOnly: input.assessmentOnly,
      }),
      instructions:
        cardCopyInstructions +
        " The complete assessment stays in this native tool call; Agent System has not saved it. Include the complete presentation, with all routing, decision and debug cards, in this turn's final response. Commentary or progress output does not count as final presentation. Append any Task Update publication outcome and current blocker to that final response without replacing the assessment cards or duplicating the full engineering source. Continue from native conversation and current direction; do not record or reinject this assessment. Formatting grants no implementation or publication authority. Publish the concise review through Task Update only within its existing authorization.",
    },
    assessmentPresentationRequest(input.target, input.assessmentOnly),
    input.material,
    {
      purpose: 'assessment-presentation',
      pagedFields: ['presentation'],
      inputFields: ['result'],
      instruction:
        'Read every presentation page before displaying the result. Copy only the listed inputFields from the original native tool call into each returned page request. This pure formatter retains no source or plan. Follow next, concatenate text in offset order, parse JSON and restore each path. Show the complete presentation. Page reads do not save a plan or authorize any effect.',
    },
  );
}

export function assessmentPresentationRequest(target: string, assessmentOnly = false) {
  return {
    action: 'assessment' as const,
    operation: 'render' as const,
    target,
    ...(assessmentOnly ? { assessmentOnly } : {}),
  };
}
