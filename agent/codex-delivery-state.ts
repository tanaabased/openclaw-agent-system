import {
  deliveryContentUpdateSchema,
  deliveryPendingPushSchema,
  deliveryPullRequestSchema,
  adoptedPullRequestSchema,
  type AdoptedPullRequest,
} from './delivery-state.ts';
import { automationHash } from './automation-hash.ts';
import { Type, type Static } from 'typebox';
import { deliveryAnnouncementStateSchema } from './delivery-announcement-state.ts';

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
    contentUpdate: Type.Optional(deliveryContentUpdateSchema),
    pushedHead: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
    pendingPush: Type.Optional(deliveryPendingPushSchema),
    pullRequest: Type.Optional(deliveryPullRequestSchema),
    adopted: Type.Optional(adoptedPullRequestSchema),
    localBranch: Type.Optional(text),
    reconciled: Type.Boolean(),
    attached: Type.Boolean(),
    cardAttempts: Type.Integer({ minimum: 0 }),
    announcement: Type.Optional(deliveryAnnouncementStateSchema),
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

/** selecting a pr records no push, attachment or announcement success. */
export function adoptedCodexDelivery(input: {
  id: string;
  repositoryId: string;
  issueId: string;
  threadId: string;
  worktree: string;
  localBranch: string;
  head: string;
  policyDigest: string;
  adopted: AdoptedPullRequest;
}): CodexDeliveryState {
  const { adopted, localBranch } = input;
  return {
    id: automationHash({ id: input.id, adopted }),
    binding: {
      repositoryId: input.repositoryId,
      issueId: input.issueId,
      threadId: input.threadId,
      worktree: input.worktree,
      branch: adopted.branch,
      base: adopted.base,
      head: input.head,
      authorId: adopted.authorId,
      policyDigest: input.policyDigest,
    },
    localBranch,
    adopted,
    title: adopted.title,
    body: adopted.body,
    pullRequest: {
      pullRequestNodeId: adopted.pullRequestNodeId,
      pullRequestNumber: adopted.pullRequestNumber,
    },
    creationAttempted: false,
    reconciled: false,
    attached: false,
    cardAttempts: 0,
  };
}
