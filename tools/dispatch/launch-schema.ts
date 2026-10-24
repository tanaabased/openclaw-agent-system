import { Type, type Static } from 'typebox';

import { assessmentConfigurationSchema } from '../../manifest/assessment-schema.ts';
import { assessmentSchema, selectedProfileSchema } from '../../agent/model-routing.ts';

export const launchRequestSchema = Type.Object(
  {
    action: Type.Literal('launch'),
    target: Type.String({ minLength: 1, maxLength: 4096 }),
    repository: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    operation: Type.Union([
      Type.Literal('context'),
      Type.Literal('prepare'),
      Type.Literal('reconcile'),
    ]),
    id: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    digest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    assessment: Type.Optional(assessmentSchema),
    fallback: Type.Optional(Type.Literal('default')),
    title: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9 -]{2,79}$' })),
    projects: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 1000 })),
    mode: Type.Optional(
      Type.Union([Type.Literal('plan'), Type.Literal('work'), Type.Literal('auto')]),
    ),
    routing: Type.Optional(Type.Partial(selectedProfileSchema)),
    stages: Type.Optional(
      Type.Object(
        {
          assessment: Type.Optional(assessmentConfigurationSchema),
          implementation: Type.Optional(assessmentConfigurationSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type LaunchRequest = Static<typeof launchRequestSchema>;
