import { Type } from 'typebox';

export const nativeRetirementProperties = {
  native: Type.String({ minLength: 1, maxLength: 4096, pattern: '^\\S+$' }),
  digest: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
};

export const retirementRequestSchema = Type.Object(
  {
    action: Type.Literal('retire'),
    id: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    native: Type.Optional(nativeRetirementProperties.native),
    digest: nativeRetirementProperties.digest,
  },
  { additionalProperties: false, not: { required: ['id', 'native'] } },
);
