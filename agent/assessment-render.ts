import safePresentation from '../channels/github/presentation/safe.ts';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { cardCopyInstructions } from '../channels/github/presentation/card.ts';
import {
  implementationContextBudget,
  implementationMaterialSize,
} from './implementation-material.ts';
import { assessmentFallbackInstructions } from './assessment-instructions.ts';

import renderAssessmentResult, {
  assessmentContextCards,
  type AssessmentPresentationContext,
} from '../channels/github/presentation/assessment-result.ts';
import type { WorkflowInstructionsPresentation } from '../channels/github/presentation/workflow-instructions.ts';
import { directAssessmentRequestSchema } from '../tools/dispatch/assessment-schema.ts';
import assessmentOwner from './assessment-owner.ts';
import { assessmentGitContext, type AssessmentGitRecord } from './assessment-git-context.ts';
import { parseAssessmentSubmission } from './assessment-result.ts';
import AssessmentValidationError from './assessment-validation.ts';
import { dispatchAssessmentContext } from './dispatch-presentation.ts';
import { dispatchAdmission, managedTargetUrl, type ManagedIssue } from './managed-issue.ts';
import { replyLocator } from './reply-target.ts';

const renderRequestSchema = Type.Object(
  {
    ...Type.Omit(directAssessmentRequestSchema, ['material']).properties,
    ...Type.Required(Type.Pick(directAssessmentRequestSchema, ['target'])).properties,
    operation: Type.Literal('render'),
  },
  { additionalProperties: false },
);

/** resolve display metadata from the bound owner without saving an assessment or advancing work. */
export async function renderBoundAssessment(
  input: unknown,
  context: {
    runtime: 'codex' | 'openclaw';
    records: AssessmentGitRecord[];
    admitted: ManagedIssue[];
    session: string;
    workspace: string;
    debug?: boolean;
    workflow?: WorkflowInstructionsPresentation['workflow'];
    repositoryDefault?(admitted: ManagedIssue): Promise<string | undefined>;
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
  const admitted = record && dispatchAdmission(record, context.admitted);
  const git =
    context.debug && record && admitted
      ? await assessmentGitContext(
          record,
          admitted,
          () => context.repositoryDefault?.(admitted) ?? Promise.resolve(undefined),
        )
      : context.debug
        ? { checkoutStartingPoint: {}, prBase: 'unknown' }
        : undefined;
  const presentation = {
    workspace: context.workspace,
    debug: context.debug,
    workflow: context.workflow ?? {},
    git,
  };
  return renderNativeAssessment(
    input,
    context.runtime,
    record
      ? dispatchAssessmentContext(
          { ...record, assessment: undefined },
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
  const assessment = parseAssessmentSubmission(input.result);
  const response = {
    runtime,
    status: 'formatted' as const,
    retained: false as const,
    presentation: safePresentation(
      () =>
        renderAssessmentResult(assessment, {
          issue: {
            label: `${target.owner}/${target.name}#${target.number}`,
            url: input.target,
            kind: target.itemType === 'pull-request' ? 'Pull request' : 'Issue',
          },
          cards: context
            ? assessmentContextCards({
                ...context,
                git: context.git ?? { checkoutStartingPoint: {}, prBase: 'unknown' },
              })
            : undefined,
          assessmentOnly: input.assessmentOnly,
        }),
      () =>
        [
          assessment.summary,
          assessment.reviewSummary,
          assessment.outcome === 'clarification-needed'
            ? assessment.questions.join('\n\n')
            : assessment.outcome === 'operator-setup-blocker'
              ? `${assessment.code}: ${assessment.remediation}`
              : '',
          input.target,
          input.assessmentOnly
            ? 'Assessment only. No implementation or publication is authorized.'
            : '',
          assessment.decision
            ? `Auto decision: ${assessment.decision.mode}\n${assessment.decision.reasons.join('\n')}`
            : '',
          'Card formatting unavailable; continue under existing authorization.',
        ]
          .filter(Boolean)
          .join('\n\n'),
    ),
    instructions:
      cardCopyInstructions +
      " The complete assessment stays in native conversation; Agent System has not saved it. Include the complete presentation, with all routing, decision and debug cards, in this turn's final response. Commentary or progress output does not count as final presentation. Append any Task Update publication outcome and current blocker to that final response without replacing the assessment cards or duplicating the full engineering source. Continue from native conversation and current direction; do not record or reinject this assessment. Formatting grants no implementation or publication authority. Publish the concise review through Task Update only within its existing authorization.",
  };
  if (implementationMaterialSize(response) <= implementationContextBudget) return response;
  // The authored findings already live in this native call. Never make displaying them
  // depend on retranscribing that input into page requests or on a new persisted plan.
  return {
    runtime,
    status: 'presentation-unavailable' as const,
    retained: false as const,
    presentation:
      'Card formatting unavailable: the presentation exceeds the native output allowance.',
    instructions:
      'Present the completed assessment from this conversation and the original render input directly as ordinary Markdown, including every unanswered question and actual blocker. Do not request pages, resubmit the result, or restart assessment. ' +
      assessmentFallbackInstructions +
      (input.assessmentOnly
        ? ' Assessment only. No implementation or publication is authorized.'
        : ''),
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
