import { Type, type Static } from 'typebox';

import { assessmentSelectionSchema } from './assessment-selection.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
export const deliveryAnnouncementStateSchema = Type.Object(
  {
    publicationId: text,
    authorId: text,
    snapshot: Type.Object(
      {
        pullRequestNodeId: text,
        pullRequestNumber: Type.Integer({ minimum: 1 }),
        draft: Type.Boolean(),
        head: text,
        title: Type.String({ maxLength: 512 }),
        body: Type.String({ maxLength: 65536 }),
      },
      { additionalProperties: false },
    ),
    composition: assessmentSelectionSchema,
    authorLogin: Type.Optional(text),
    publicText: Type.Optional(Type.String({ minLength: 1, maxLength: 800 })),
    attempted: Type.Boolean(),
    receipt: Type.Optional(
      Type.Object(
        { nodeId: text, databaseId: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type DeliveryAnnouncementState = Static<typeof deliveryAnnouncementStateSchema>;
