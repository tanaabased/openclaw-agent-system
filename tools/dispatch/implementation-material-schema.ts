import { Type, type TObject } from 'typebox';

export const implementationMaterialSchema = Type.Object(
  {
    path: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 40 }),
    digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

/** Page location is a resource choice; the content version belongs to native response custody. */
export const modelMaterialSchema = Type.Omit(implementationMaterialSchema, ['digest'], {
  additionalProperties: false,
});

export function modelMaterialParameters<T extends TObject>(schema: T): T {
  return schema.properties.material
    ? {
        ...schema,
        properties: { ...schema.properties, material: Type.Optional(modelMaterialSchema) },
      }
    : schema;
}
