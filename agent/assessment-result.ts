import { Type, type Static } from 'typebox';
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
  // complete source for new assessments; existing structured results remain supported.
  fullAssessment: Type.Optional(text),
  // explicit human review; absent on older results, whose complete display is preserved.
  reviewSummary: Type.Optional(text),
  decision: Type.Optional(assessmentDecisionSchema),
};

/** shared issue assessment contract owned by #249; lifecycle identity stays runtime-owned. */
const assessmentResultVariants = Type.Union([
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
export const assessmentResultSchema = discriminatedSchema('outcome', assessmentResultVariants);
// share repeated field schemas without changing the model-facing validation contract.
const contextText = { $ref: '#/$defs/text' };
const contextFields: Record<string, unknown> = {
  ...Object.fromEntries(
    [
      'summary',
      'assessment',
      'fullAssessment',
      'reviewSummary',
      'planSummary',
      'plan',
      'remediation',
    ].map((key) => [key, contextText]),
  ),
  evidence: { $ref: '#/$defs/evidence' },
  progress: { $ref: '#/$defs/progress' },
  decision: { $ref: '#/$defs/decision' },
  questions: { type: 'array', items: contextText, minItems: 1, maxItems: 10 },
};
const contextRequired: string[] = assessmentResultVariants.anyOf[0].required.filter((key) =>
  assessmentResultVariants.anyOf.every((variant) =>
    variant.required.some((required) => required === key),
  ),
);
export const assessmentResultContextSchema = {
  $defs: {
    text,
    evidence: {
      ...evidence,
      items: {
        ...evidence.items,
        properties: { ...evidence.items.properties, detail: contextText },
      },
    },
    progress: {
      ...progress,
      properties: Object.fromEntries(
        Object.entries(progress.properties).map(([key, schema]) => [
          key,
          { ...schema, items: contextText },
        ]),
      ),
    },
    decision: currentDecisionSchema,
  },
  type: 'object',
  additionalProperties: false,
  required: contextRequired,
  properties: {
    ...Object.fromEntries(
      assessmentResultVariants.anyOf.flatMap((variant) =>
        Object.entries(variant.properties).map(([key, schema]) => [
          key,
          contextFields[key] ?? schema,
        ]),
      ),
    ),
    outcome: Type.String(),
  },
  anyOf: assessmentResultVariants.anyOf.map((variant) => ({
    required: variant.required.filter((key) => !contextRequired.includes(key)),
    properties: {
      outcome: variant.properties.outcome,
      ...Object.fromEntries(
        [
          ...new Set(
            assessmentResultVariants.anyOf.flatMap((entry) => Object.keys(entry.properties)),
          ),
        ]
          .filter((key) => !(key in variant.properties))
          .map((key) => [key, false]),
      ),
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
