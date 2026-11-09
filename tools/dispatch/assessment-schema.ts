import { Type } from 'typebox';
import { implementationMaterialSchema } from './implementation-material-schema.ts';

import { assessmentPresentationSchema } from '../../agent/assessment-result.ts';

export const directAssessmentRequestSchema = Type.Object(
  {
    action: Type.Literal('assessment'),
    operation: Type.Union([
      Type.Literal('context'),
      Type.Literal('render'),
      Type.Literal('result'),
      Type.Literal('present'),
    ]),
    material: Type.Optional(implementationMaterialSchema),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    revise: Type.Optional(Type.Boolean()),
    includeDetails: Type.Optional(Type.Boolean()),
    assessmentOnly: Type.Optional(Type.Boolean()),
    result: Type.Optional(assessmentPresentationSchema),
  },
  { additionalProperties: false },
);
