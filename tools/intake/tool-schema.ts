import { Type } from 'typebox';
import { pickupInputSchema } from '../../agent/issue-pickup.ts';

export const intakeParameters = Type.Union([
  Type.Object(
    { action: Type.Literal('pickup'), ...Type.Omit(pickupInputSchema, ['cancel']).properties },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal('inspect') }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Union([Type.Literal('check'), Type.Literal('scan')]),
    },
    { additionalProperties: false },
  ),
]);
