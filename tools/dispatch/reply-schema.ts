import { Type, type Static } from 'typebox';

import { maximumGitHubNotificationReplyLength } from '../../channels/github/publication/limits.ts';

const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const statusUpdateSchema = Type.Object(
  {
    observation: hash,
    facts: Type.Array(
      Type.Object(
        {
          key: Type.String({ minLength: 1, maxLength: 256 }),
          reference: Type.String({ minLength: 1, maxLength: 2048 }),
          revision: Type.String({ minLength: 1, maxLength: 256 }),
          text: Type.String({ minLength: 1, maxLength: 4000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);
export type StatusUpdate = Static<typeof statusUpdateSchema>;
export const replyRequestSchema = Type.Object(
  {
    action: Type.Literal('reply'),
    operation: Type.Union([
      Type.Literal('context'),
      Type.Literal('compose'),
      Type.Literal('candidate'),
      Type.Literal('publish'),
      Type.Literal('reconcile'),
    ]),
    purpose: Type.Optional(Type.Literal('status-update')),
    update: Type.Optional(statusUpdateSchema),
    id: Type.Optional(hash),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    privateText: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })),
    outcome: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })),
    digest: Type.Optional(hash),
    publicText: Type.Optional(
      Type.String({ minLength: 1, maxLength: maximumGitHubNotificationReplyLength }),
    ),
  },
  { additionalProperties: false },
);
export type ReplyRequest = Static<typeof replyRequestSchema>;
