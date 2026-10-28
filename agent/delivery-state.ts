import { automationHash } from './automation-hash.ts';
import { Type, type Static } from 'typebox';

const text = Type.String({ minLength: 1, maxLength: 4096 });

export const deliveryContentUpdateSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    body: Type.Optional(Type.String({ maxLength: 65536 })),
  },
  { additionalProperties: false },
);

export const deliveryPendingPushSchema = Type.Object(
  {
    previousHead: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
    head: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
  },
  { additionalProperties: false },
);

export const deliveryPullRequestSchema = Type.Object(
  {
    pullRequestNodeId: text,
    pullRequestNumber: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const adoptedPullRequestSchema = Type.Object(
  {
    ...deliveryPullRequestSchema.properties,
    branch: text,
    base: text,
    head: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
    authorId: text,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    body: Type.String({ maxLength: 65536 }),
  },
  { additionalProperties: false },
);
export type AdoptedPullRequest = Static<typeof adoptedPullRequestSchema>;

/** selecting a pr records no push, attachment or announcement success. */
export function adoptedIssueDelivery(input: {
  id: string;
  repositoryId: string;
  issueId: string;
  threadId: string;
  worktree: string;
  localBranch: string;
  head: string;
  policyDigest: string;
  adopted: AdoptedPullRequest;
}) {
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
  };
}
