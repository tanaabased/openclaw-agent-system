import { Type } from 'typebox';

export const operatorTargetProperties = {
  target: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  chat: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
};
const object = (properties: Parameters<typeof Type.Object>[0]) =>
  Type.Object(properties, { additionalProperties: false });
export const codexRecoveryModelSchema = Type.Union([
  object({
    action: Type.Literal('reset'),
    ...operatorTargetProperties,
    preview: Type.Optional(Type.Boolean()),
  }),
  object({
    action: Type.Literal('retry-denied'),
    ...operatorTargetProperties,
    preview: Type.Optional(Type.Boolean()),
    renewAuthorization: Type.Optional(Type.Boolean()),
  }),
]);
