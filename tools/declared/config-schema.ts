import { Type, type Static } from 'typebox';

// The identifier is also a filename in the agent's launcher directory.
export const declaredToolsSchema = Type.Record(
  Type.String({
    pattern:
      '^(?!(?:git|gh|gog|worktree|lifecycle|openclaw|agent-system(?:-.*)?)$)[a-z][a-z0-9-]{0,63}$',
  }),
  Type.Object(
    {
      executable: Type.String({ minLength: 1, pattern: '^[^\\u0000\\r\\n]+$' }),
      environment: Type.Array(
        Type.String({ pattern: '^(?!OP_SERVICE_ACCOUNT_TOKEN$)[A-Za-z_][A-Za-z0-9_]*$' }),
        { uniqueItems: true },
      ),
    },
    { additionalProperties: false },
  ),
  { additionalProperties: false },
);

export type DeclaredTools = Static<typeof declaredToolsSchema>;
