import { Type } from 'typebox';
import { implementationMaterialSchema } from './implementation-material-schema.ts';

import { assessmentPresentationSchema } from '../../agent/tasks/assessment/assessment-result.ts';

export const directAssessmentRequestSchema = Type.Object(
  {
    action: Type.Literal('assessment'),
    operation: Type.Union([Type.Literal('context'), Type.Literal('render')]),
    material: Type.Optional(implementationMaterialSchema),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    assessmentOnly: Type.Optional(Type.Boolean()),
    result: Type.Optional(assessmentPresentationSchema),
  },
  { additionalProperties: false },
);
