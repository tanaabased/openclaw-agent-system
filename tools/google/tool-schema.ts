import { Type, type Static } from 'typebox';

export const googleToolSchema = Type.Object(
  {
    argv: Type.Array(Type.String({ maxLength: 65536 }), { minItems: 1, maxItems: 256 }),
    stdin: Type.Optional(Type.String({ maxLength: 65536 })),
  },
  { additionalProperties: false },
);
export type GoogleToolInput = Static<typeof googleToolSchema>;
