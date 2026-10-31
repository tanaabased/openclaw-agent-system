import { Type } from 'typebox';

export const implementationMaterialSchema = Type.Object(
  {
    path: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 40 }),
    digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
