import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import discriminatedSchema from '../utils/discriminated-schema.ts';
import AssessmentValidationError from './assessment-validation.ts';

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
const common = {
  summary: text,
  reviewSummary: Type.Optional(text),
  decision: Type.Optional(assessmentDecisionSchema),
};
const variants = Type.Union([
  Type.Object({ ...common, outcome: Type.Literal('plan-ready') }, { additionalProperties: false }),
  Type.Object(
    {
      ...common,
      outcome: Type.Literal('clarification-needed'),
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
export const assessmentResultSchema = discriminatedSchema('outcome', variants);
export const assessmentPresentationSchema = assessmentResultSchema;
export const assessmentSubmissionSchema = assessmentResultSchema;
export const assessmentResultContextSchema = assessmentResultSchema;
export type AssessmentResult = Static<typeof assessmentResultSchema>;
export type AssessmentSubmission = AssessmentResult;
export const assessmentResultFormat = {
  common: 'summary:string',
  outcomes: {
    'plan-ready': 'outcome:plan-ready',
    'clarification-needed': 'outcome:clarification-needed; questions:string[]',
    'operator-setup-blocker': 'outcome:operator-setup-blocker; code:string; remediation:string',
  },
  optional:
    'reviewSummary:string; decision:{mode:plan|work,reasons:string[]}; a work decision requires plan-ready',
};

export function parseAssessmentResult(value: unknown): AssessmentResult {
  if (!Value.Check(assessmentResultSchema, value))
    throw new AssessmentValidationError(
      'assessment-result-invalid',
      assessmentResultSchema,
      value,
      'result',
    );
  if (JSON.stringify(value).length > 96000) throw new Error('assessment-result-invalid');
  if (assessmentDecisionMode(value.decision) === 'work' && value.outcome !== 'plan-ready')
    throw new Error('assessment-decision-conflict');
  return value;
}

export const parseAssessmentSubmission = parseAssessmentResult;
