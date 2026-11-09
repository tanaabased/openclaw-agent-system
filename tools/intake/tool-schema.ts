import { Type } from 'typebox';
import { pickupInputSchema } from '../../agent/issue-pickup.ts';
import { modelMaterialSchema } from '../dispatch/implementation-material-schema.ts';

export const intakeParameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal('pickup'),
      ...Type.Omit(pickupInputSchema, ['cancel']).properties,
      material: Type.Optional(modelMaterialSchema),
    },
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
