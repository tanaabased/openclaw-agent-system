import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

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
  // complete source for new assessments; existing structured results remain supported.
  fullAssessment: Type.Optional(text),
  // explicit human review; absent on older results, whose complete display is preserved.
  reviewSummary: Type.Optional(text),
  decision: Type.Optional(assessmentDecisionSchema),
};

/** shared issue assessment contract owned by #249; lifecycle identity stays runtime-owned. */
export const assessmentResultSchema = Type.Union([
  Type.Object(
    {
      ...common,
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
      outcome: Type.Literal('clarification-needed'),
      assessment: text,
      questions: Type.Array(text, { minItems: 1, maxItems: 10 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...common,
      outcome: Type.Literal('operator-setup-blocker'),
      code: Type.String({ pattern: '^[a-z][a-z0-9-]{0,127}$' }),
      remediation: text,
    },
    { additionalProperties: false },
  ),
]);
// the model-facing contract shares repeated fields instead of expanding them per outcome.
export const assessmentResultContextSchema = {
  $defs: { ...common, decision: Type.Optional(currentDecisionSchema) },
  anyOf: assessmentResultSchema.anyOf.map((variant) => ({
    ...variant,
    properties: {
      ...variant.properties,
      ...Object.fromEntries(Object.keys(common).map((key) => [key, { $ref: `#/$defs/${key}` }])),
    },
  })),
};
export type AssessmentResult = Static<typeof assessmentResultSchema>;

export function parseAssessmentResult(value: unknown): AssessmentResult {
  if (!Value.Check(assessmentResultSchema, value) || JSON.stringify(value).length > 96000)
    throw new Error('assessment-result-invalid');
  if (assessmentDecisionMode(value.decision) === 'work' && value.outcome !== 'plan-ready')
    throw new Error('assessment-decision-conflict');
  return value;
}
