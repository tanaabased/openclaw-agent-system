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
