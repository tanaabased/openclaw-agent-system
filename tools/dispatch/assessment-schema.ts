import { Type } from 'typebox';

import { assessmentSubmissionSchema } from '../../agent/assessment-result.ts';

const id = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const directAssessmentRequestSchema = Type.Object(
  {
    action: Type.Literal('assessment'),
    operation: Type.Union([
      Type.Literal('context'),
      Type.Literal('result'),
      Type.Literal('present'),
    ]),
    id: Type.Optional(id),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    revise: Type.Optional(Type.Boolean()),
    includeDetails: Type.Optional(Type.Boolean()),
    previousResultDigest: Type.Optional(id),
    result: Type.Optional(assessmentSubmissionSchema),
  },
  { additionalProperties: false },
);
