import { Type, type Static } from 'typebox';

import { assessmentSchema, selectedProfileSchema } from '../../agent/model-routing.ts';

export const modelRoutingRequestSchema = Type.Union([
  Type.Object({ action: Type.Literal('inspect') }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal('resolve'),
      manifestDigest: Type.String({ minLength: 1, maxLength: 128 }),
      context: Type.String({ minLength: 1, maxLength: 18000 }),
      assessment: assessmentSchema,
      evidence: Type.Optional(
        Type.Object(
          {
            complexity: Type.Union([
              Type.Literal('low'),
              Type.Literal('medium'),
              Type.Literal('high'),
            ]),
            source: Type.Union([
              Type.Literal('user'),
              Type.Literal('native'),
              Type.Literal('body fallback'),
            ]),
          },
          { additionalProperties: false },
        ),
      ),
      overrides: Type.Optional(
        Type.Object(
          {
            model: Type.Optional(
              Type.String({ minLength: 1, maxLength: 200, pattern: '^[^@\\s]+$' }),
            ),
            effort: Type.Optional(selectedProfileSchema.properties.effort),
          },
          { additionalProperties: false },
        ),
      ),
      fallback: Type.Optional(Type.Literal('default')),
    },
    { additionalProperties: false },
  ),
]);

export type ModelRoutingRequest = Static<typeof modelRoutingRequestSchema>;

// native function schemas require an object root; conditional fields are checked by the request schema.
export const modelRoutingParameters = Type.Object(
  {
    ...Type.Partial(modelRoutingRequestSchema.anyOf[1]).properties,
    action: Type.Union([Type.Literal('inspect'), Type.Literal('resolve')]),
  },
  { additionalProperties: false },
);
