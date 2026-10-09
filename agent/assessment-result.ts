import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const text = Type.String({ minLength: 1, maxLength: 32000, pattern: '\\S' });
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
const common = { version: Type.Literal(1), summary: text, evidence, progress };

/** shared issue assessment contract owned by #249; lifecycle identity stays runtime-owned. */
export const assessmentResultSchema = Type.Union([
  Type.Object(
    {
      ...common,
      outcome: Type.Literal('plan-ready'),
      assessment: text,
      // optional for retained version 1 results written before summary/full-plan presentation.
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
export type AssessmentResult = Static<typeof assessmentResultSchema>;

export function parseAssessmentResult(value: unknown): AssessmentResult {
  if (!Value.Check(assessmentResultSchema, value) || JSON.stringify(value).length > 96000)
    throw new Error('assessment-result-invalid');
  return value;
}
