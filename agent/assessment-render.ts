import implementationMaterial from './implementation-material.ts';
import { Value } from 'typebox/value';
import { Type } from 'typebox';

import renderAssessmentResult, {
  assessmentContextCards,
  type AssessmentPresentationContext,
} from '../channels/github/presentation/assessment-result.ts';
import { directAssessmentRequestSchema } from '../tools/dispatch/assessment-schema.ts';
import { parseAssessmentSubmission } from './assessment-result.ts';
import { replyLocator } from './reply-target.ts';
import assessmentOwner from './assessment-owner.ts';
import { dispatchAssessmentContext } from './dispatch-presentation.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { ManagedIssue } from './managed-issue.ts';
import type { AssessmentSelection } from './assessment-selection.ts';
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
const boundRenderRequestSchema = Type.Object(
  {
    ...renderRequestSchema.properties,
    ...Type.Required(Type.Pick(directAssessmentRequestSchema, ['id'])).properties,
  },
  { additionalProperties: false },
);

/** resolve display metadata from the bound owner without saving an assessment or advancing work. */
export function renderBoundAssessment(
  input: unknown,
  context: {
    runtime: 'codex' | 'openclaw';
    records: Array<SharedDispatchRecord & { turnEvidence?: { selection?: AssessmentSelection } }>;
    admitted: ManagedIssue[];
    session: string;
    workspace: string;
    debug?: boolean;
  },
) {
  if (!Value.Check(boundRenderRequestSchema, input))
    throw new AssessmentValidationError(
      'assessment-render-request-invalid',
      boundRenderRequestSchema,
      input,
      'request',
    );
  const target = replyLocator(input.target);
  const owner = assessmentOwner(context.records, context.admitted, context.session, {
    repository: `${target.owner}/${target.name}`,
    number: target.number,
  });
  if (!owner || owner.record.id !== input.id) throw new Error('assessment-managed-context-invalid');
  const record = owner.record;
  return renderNativeAssessment(
    {
      ...input,
      cards: assessmentContextCards(
        dispatchAssessmentContext(
          {
            ...record,
            assessment: record.turnEvidence?.selection ?? record.assessment,
            stageReceipt: undefined,
          },
          context.workspace,
          { debug: context.debug },
        ),
      ),
    },
    context.runtime,
  );
}

/** Pure presentation: the native tool exchange owns the full source, not a task journal. */
export default function renderNativeAssessment(
  input: unknown,
  runtime: 'codex' | 'openclaw' = 'codex',
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
        "The complete assessment stays in this native tool call; Agent System has not saved it. Include the complete presentation, with all routing, decision and debug cards, in this turn's final response. Commentary or progress output does not count as final presentation. Append any Task Update publication outcome and current blocker to that final response without replacing the assessment cards or duplicating the full engineering source. Continue from native conversation and current direction; do not record or reinject this assessment. Formatting grants no implementation or publication authority. Publish the concise review through Task Update only within its existing authorization.",
    },
    {
      ...assessmentPresentationRequest(input.target, input.assessmentOnly),
      ...(input.id ? { id: input.id } : {}),
    },
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
