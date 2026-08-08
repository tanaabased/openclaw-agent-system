import { Type, type Static } from 'typebox';

export const githubToolSchema = Type.Object(
  {
    argv: Type.Tuple([Type.Literal('api'), Type.Literal('user')]),
  },
  { additionalProperties: false },
);

export type GitHubToolInput = Static<typeof githubToolSchema>;
