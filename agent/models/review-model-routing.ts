import type { ReviewRoutingContext } from '../../channels/github/provider/review-routing-context.ts';
import type { AgentModelsConfiguration } from '../../manifest/models-schema.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import { assessmentSchema, type RoutingOverrides } from './model-routing.ts';
import { Value } from 'typebox/value';

export const reviewRoutingGuidance =
  'Use the shared complexity rubric and the reviewer’s configured profiles. Read the PR, relevant discussion and a bounded diff; line count alone is not complexity. A unique provider-linked issue supplies context and verified Complexity, not the author’s model. Preserve explicit operator selections. If the actual review scope conflicts materially with verified Complexity, report the discrepancy instead of silently overriding it. Missing, ambiguous or unavailable links permit a labelled PR-content assessment; use unset and the configured default when no tier is defensible. Preserve the saved model and effort on follow-ups.';

export default function reviewModelRouting(input: {
  models: AgentModelsConfiguration | undefined;
  manifestDigest: string;
  runtime: 'codex' | 'openclaw';
  context: ReviewRoutingContext;
  assessment: unknown;
  overrides?: RoutingOverrides;
}) {
  const complexity =
    input.context.linkedIssueStatus === 'unique'
      ? input.context.linkedIssue?.metadata?.complexity
      : undefined;
  const assessment =
    Value.Check(assessmentSchema, input.assessment) &&
    input.assessment.complexity === 'unset' &&
    complexity?.status === 'verified' &&
    complexity.value
      ? {
          ...input.assessment,
          complexity: complexity.value,
          reason:
            'Verified Complexity from the uniquely linked issue selects this tier; independent PR-content assessment was unset.',
        }
      : input.assessment;
  return resolveModelRoutingRequest(
    input.models,
    input.manifestDigest,
    {
      action: 'resolve',
      context: JSON.stringify(input.context),
      assessment,
      ...(complexity?.status === 'verified' && complexity.value
        ? { evidence: { complexity: complexity.value, source: complexity.source } }
        : {}),
      ...(input.overrides ? { overrides: input.overrides } : {}),
      fallback: 'default',
    },
    input.runtime,
  );
}
