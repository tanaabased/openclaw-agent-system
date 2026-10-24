import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import discriminatedSchema from '../utils/discriminated-schema.ts';

const text = Type.String({ minLength: 1, maxLength: 32000, pattern: '\\S' });
const decisionReasons = Type.Array(Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }), {
  minItems: 1,
  maxItems: 5,
});
const currentDecisionSchema = Type.Object(
  { mode: Type.Union([Type.Literal('plan'), Type.Literal('work')]), reasons: decisionReasons },
  { additionalProperties: false },
);
export const assessmentDecisionSchema = currentDecisionSchema;

export function assessmentDecisionMode(decision?: { mode: 'plan' | 'work' }) {
  return decision?.mode;
}
const evidence = Type.Array(
  Type.Object(
    {
      source: Type.String({ minLength: 1, maxLength: 4096 }),
      status: Type.Union([
        Type.Literal('observed'),
        Type.Literal('absent'),
        Type.Literal('unavailable'),
        Type.Literal('conflicting'),
        Type.Literal('assumed'),
      ]),
      detail: text,
    },
    { additionalProperties: false },
  ),
  { maxItems: 40 },
);
const progress = Type.Object(
  {
    completed: Type.Array(text, { maxItems: 20 }),
    remaining: Type.Array(text, { maxItems: 20 }),
  },
  { additionalProperties: false },
);
const common = {
  version: Type.Literal(1),
  summary: text,
  evidence,
  progress,
  // explicit human review; absent on older results, whose complete display is preserved.
  reviewSummary: Type.Optional(text),
  decision: Type.Optional(assessmentDecisionSchema),
};

/** shared issue assessment contract owned by #249; lifecycle identity stays runtime-owned. */
function resultVariants<S extends TSchema>(fullAssessment: S) {
  return Type.Union([
    Type.Object(
      {
        ...common,
        fullAssessment,
        outcome: Type.Literal('plan-ready'),
        assessment: text,
        // optional when the recommendation and complete source already explain the proposal.
        planSummary: Type.Optional(text),
        plan: text,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...common,
        fullAssessment,
        outcome: Type.Literal('clarification-needed'),
        assessment: text,
        questions: Type.Array(text, { minItems: 1, maxItems: 10 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...common,
        fullAssessment,
        outcome: Type.Literal('operator-setup-blocker'),
        code: Type.String({ pattern: '^[a-z][a-z0-9-]{0,127}$' }),
        remediation: text,
      },
      { additionalProperties: false },
    ),
  ]);
}
const assessmentResultVariants = resultVariants(Type.Optional(text));
export const assessmentResultSchema = discriminatedSchema('outcome', assessmentResultVariants);
const submissionVariants = resultVariants(text);
// saved results retain the legacy shape; new submissions must supply their summary source.
export const assessmentSubmissionSchema = discriminatedSchema('outcome', submissionVariants);
// the model-facing contract shares repeated fields instead of expanding them per outcome.
export const assessmentResultContextSchema = {
  $defs: { ...common, fullAssessment: text, decision: Type.Optional(currentDecisionSchema) },
  anyOf: submissionVariants.anyOf.map((variant) => ({
    ...variant,
    properties: {
      ...variant.properties,
      ...Object.fromEntries(
        Object.keys({ ...common, fullAssessment: text }).map((key) => [
          key,
          { $ref: `#/$defs/${key}` },
        ]),
      ),
    },
  })),
};
export type AssessmentSubmission = Static<typeof assessmentSubmissionSchema>;
export type AssessmentResult = Static<typeof assessmentResultSchema>;

export function parseAssessmentResult(value: unknown): AssessmentResult {
  if (!Value.Check(assessmentResultSchema, value) || JSON.stringify(value).length > 96000)
    throw new Error('assessment-result-invalid');
  if (assessmentDecisionMode(value.decision) === 'work' && value.outcome !== 'plan-ready')
    throw new Error('assessment-decision-conflict');
  return value;
}

export function parseAssessmentSubmission(value: unknown): AssessmentSubmission {
  if (value && typeof value === 'object') {
    const source = (value as { fullAssessment?: unknown }).fullAssessment;
    if (typeof source !== 'string' || !source.trim())
      throw Object.assign(
        new Error(
          'assessment-result-incomplete: include the complete assessment in fullAssessment and resubmit in this chat.',
        ),
        { code: 'assessment-result-incomplete' },
      );
  }
  const result = parseAssessmentResult(value);
  return result as AssessmentSubmission;
}
