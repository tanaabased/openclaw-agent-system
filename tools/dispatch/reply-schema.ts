import { Type, type Static } from 'typebox';

import { maximumGitHubNotificationReplyLength } from '../../channels/github/publication/limits.ts';

const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const replyRequestSchema = Type.Object(
  {
    action: Type.Literal('reply'),
    operation: Type.Union([
      Type.Literal('compose'),
      Type.Literal('candidate'),
      Type.Literal('publish'),
      Type.Literal('reconcile'),
    ]),
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
