import { Type } from 'typebox';

export const intakeParameters = Type.Union([
  Type.Object({ action: Type.Literal('inspect') }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Union([Type.Literal('check'), Type.Literal('scan')]),
      policyDigest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    },
    { additionalProperties: false },
  ),
]);
