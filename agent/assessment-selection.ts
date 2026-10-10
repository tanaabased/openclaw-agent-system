import { Type } from 'typebox';

import { maximumAssessmentGuidanceBytes } from '../manifest/assessment-schema.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const assessmentSelectionSchema = Type.Object(
  {
    version: Type.Literal(1),
    requestedSkill: text,
    defaultSkill: Type.Boolean(),
    skill: Type.Object(
      { name: text, path: text, scope: text, digest },
      { additionalProperties: false },
    ),
    guidance: Type.Optional(
      Type.Object(
        {
          source: Type.Union([Type.Literal('inline'), Type.Literal('file')]),
          path: Type.Optional(text),
          content: Type.String({ minLength: 1, maxLength: maximumAssessmentGuidanceBytes }),
          digest,
        },
        { additionalProperties: false },
      ),
    ),
    observedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
