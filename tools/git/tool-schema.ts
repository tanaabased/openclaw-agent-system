import { Type, type Static } from 'typebox';

export const gitToolSchema = Type.Object(
  {
    argv: Type.Array(Type.String(), { minItems: 1, maxItems: 256 }),
    cwd: Type.Optional(Type.String({ maxLength: 4096, minLength: 1 })),
    stdin: Type.Optional(Type.String({ maxLength: 65_536 })),
  },
  { additionalProperties: false },
);

export type GitToolInput = Static<typeof gitToolSchema>;
