import {
  deliveryContentUpdateSchema,
  deliveryPendingPushSchema,
  deliveryPullRequestSchema,
  adoptedPullRequestSchema,
  adoptedIssueDelivery,
} from './delivery-state.ts';
import { Type, type Static } from 'typebox';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const issueDeliveryStateSchema = Type.Object(
  {
    id: hash,
    binding: Type.Object(
      {
        repositoryId: text,
        issueId: text,
        threadId: text,
        sessionId: Type.Optional(text),
        worktree: text,
        branch: text,
        base: text,
        head: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
        authorId: text,
      },
      { additionalProperties: false },
    ),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    body: Type.Optional(Type.String({ maxLength: 65536 })),
    creationAttempted: Type.Boolean(),
    contentUpdate: Type.Optional(deliveryContentUpdateSchema),
    contentUpdateAttempted: Type.Optional(Type.Boolean()),
    pushedHead: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
    pendingPush: Type.Optional(deliveryPendingPushSchema),
    pullRequest: Type.Optional(deliveryPullRequestSchema),
    adopted: Type.Optional(adoptedPullRequestSchema),
    localBranch: Type.Optional(text),
    reconciled: Type.Boolean(),
    attached: Type.Optional(Type.Boolean()),
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
export type IssueDeliveryState = Static<typeof issueDeliveryStateSchema>;

export function adoptedCodexDelivery(
  input: Parameters<typeof adoptedIssueDelivery>[0],
): IssueDeliveryState {
  return { ...adoptedIssueDelivery(input), attached: false };
}
