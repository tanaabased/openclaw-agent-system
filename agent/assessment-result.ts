import { Type, type Static, type TSchema } from 'typebox';
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
const presentationVariants = Type.Union(
  submissionVariants.anyOf.map((variant) =>
    Type.Object(
      {
        ...variant.properties,
        version: Type.Optional(Type.Literal(1)),
        evidence: Type.Optional(evidence),
        progress: Type.Optional(progress),
      },
      { additionalProperties: false },
    ),
  ),
);
type AssessmentPresentationInput<T = Static<typeof assessmentSubmissionSchema>> = T extends unknown
  ? Omit<T, 'version' | 'evidence' | 'progress'> & {
      version?: 1;
      evidence?: Static<typeof evidence>;
      progress?: Static<typeof progress>;
    }
  : never;
export const assessmentPresentationSchema = Type.Unsafe<AssessmentPresentationInput>(
  discriminatedSchema('outcome', presentationVariants),
);
// the model-facing contract shares repeated fields instead of expanding them per outcome.
export const assessmentResultContextSchema = {
  $defs: { ...common, fullAssessment: text, decision: Type.Optional(currentDecisionSchema) },
  anyOf: presentationVariants.anyOf.map((variant) => ({
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

export const assessmentResultFormat = {
  common: 'summary, fullAssessment, reviewSummary:string',
  outcomes: {
    'plan-ready': 'outcome:plan-ready; assessment:string; plan:string',
    'clarification-needed': 'outcome:clarification-needed; assessment:string; questions:string[]',
    'operator-setup-blocker': 'outcome:operator-setup-blocker; code:string; remediation:string',
  },
  optional:
    'version:1; evidence:[{source:string,status:observed|absent|unavailable|conflicting|assumed,detail:string}]; progress:{completed:string[],remaining:string[]} (version and empty supporting details supplied when omitted); decision:{mode:plan|work,reasons:string[]}; a work decision requires plan-ready',
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

export function parseAssessmentSubmission(value: unknown): AssessmentSubmission {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>;
    value = {
      ...fields,
      version: fields.version === undefined ? 1 : fields.version,
      evidence: fields.evidence === undefined ? [] : fields.evidence,
      progress: fields.progress === undefined ? { completed: [], remaining: [] } : fields.progress,
    };
  }
  if (value && typeof value === 'object') {
    const source = (value as { fullAssessment?: unknown }).fullAssessment;
    if (typeof source !== 'string' || !source.trim())
      throw new AssessmentValidationError(
        'assessment-result-incomplete',
        Type.Object({ fullAssessment: text }),
        value,
        'result',
      );
  }
  const result = parseAssessmentResult(value);
  return result as AssessmentSubmission;
}
