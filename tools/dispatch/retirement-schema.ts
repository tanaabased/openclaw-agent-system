import { Type } from 'typebox';

export const nativeRetirementProperties = {
  native: Type.String({ minLength: 1, maxLength: 4096, pattern: '^\\S+$' }),
  digest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  apply: Type.Optional(Type.Boolean()),
};

export const retirementRequestSchema = Type.Object(
  {
    action: Type.Literal('retire'),
    id: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    native: Type.Optional(nativeRetirementProperties.native),
    digest: nativeRetirementProperties.digest,
    apply: nativeRetirementProperties.apply,
  },
  { additionalProperties: false, not: { required: ['id', 'native'] } },
);

export const retirementModelSchema = Type.Object(
  {
    action: Type.Literal('retire'),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    native: Type.Optional(nativeRetirementProperties.native),
    preview: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, not: { required: ['target', 'native'] } },
);
