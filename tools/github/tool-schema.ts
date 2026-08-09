import { Type, type Static } from 'typebox';

export const githubToolSchema = Type.Object(
  {
    argv: Type.Array(Type.String({ maxLength: 8192 }), {
      maxItems: 128,
      minItems: 1,
    }),
    stdin: Type.Optional(Type.String({ maxLength: 65_536 })),
  },
  { additionalProperties: false },
);

export type GitHubToolInput = Static<typeof githubToolSchema>;
