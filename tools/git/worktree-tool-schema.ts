import { Type, type Static } from 'typebox';

const boundedIdentifier = Type.String({
  maxLength: 256,
  minLength: 1,
  pattern: '^(?!-)(?!\\s)(?!.*\\s$)[^\\u0000-\\u001F\\u007F]+$',
});
const repository = Type.Object(
  {
    cloneUrl: Type.Optional(Type.String({ maxLength: 4096, minLength: 1 })),
    id: boundedIdentifier,
  },
  { additionalProperties: false },
);

export const gitWorktreeToolSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal('prepare'),
      baseRef: boundedIdentifier,
      branch: Type.Optional(boundedIdentifier),
      repository,
      workId: boundedIdentifier,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal('list'), repositoryId: Type.Optional(boundedIdentifier) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal('remove'), repositoryId: boundedIdentifier, workId: boundedIdentifier },
    { additionalProperties: false },
  ),
]);

export type GitWorktreeToolInput = Static<typeof gitWorktreeToolSchema>;
