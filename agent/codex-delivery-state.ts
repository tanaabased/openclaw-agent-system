import { Type, type Static } from 'typebox';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const codexDeliveryStateSchema = Type.Object(
  {
    id: hash,
    binding: Type.Object(
      {
        repositoryId: text,
        issueId: text,
        threadId: text,
        worktree: text,
        branch: text,
        base: text,
        head: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
        authorId: text,
        policyDigest: hash,
      },
      { additionalProperties: false },
    ),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    body: Type.Optional(Type.String({ maxLength: 65536 })),
    creationAttempted: Type.Boolean(),
    pushedHead: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
    pullRequest: Type.Optional(
      Type.Object(
        {
          pullRequestNodeId: text,
          pullRequestNumber: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    reconciled: Type.Boolean(),
    attached: Type.Boolean(),
    cardAttempts: Type.Integer({ minimum: 0 }),
    notices: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal('delivery-linkage-retried'),
          Type.Literal('delivery-ssh-transport'),
        ]),
        { maxItems: 2 },
      ),
    ),
  },
  { additionalProperties: false },
);
export type CodexDeliveryState = Static<typeof codexDeliveryStateSchema>;
