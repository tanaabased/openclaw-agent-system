import { Type, type Static } from 'typebox';

import { maximumGitHubNotificationReplyLength } from '../publication/limits.ts';

const body = Type.String({ minLength: 1, maxLength: maximumGitHubNotificationReplyLength });
const side = Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')]);
export const reviewDraftSchema = Type.Object(
  {
    event: Type.Union([
      Type.Literal('COMMENT'),
      Type.Literal('REQUEST_CHANGES'),
      Type.Literal('APPROVE'),
    ]),
    body,
    comments: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\u0000\\r\\n]+$' }),
          body,
          line: Type.Integer({ minimum: 1 }),
          side,
          startLine: Type.Optional(Type.Integer({ minimum: 1 })),
          startSide: Type.Optional(side),
        },
        { additionalProperties: false },
      ),
      { maxItems: 400 },
    ),
  },
  { additionalProperties: false },
);
export type ReviewDraft = Static<typeof reviewDraftSchema>;

export const reviewEventState = {
  COMMENT: 'COMMENTED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  APPROVE: 'APPROVED',
} as const;
