import { Type, type Static } from 'typebox';
import { feedbackSourceEventSchema, feedbackSourceStateSchema } from './feedback-state.ts';
export { feedbackResultSchema } from './feedback-state.ts';
const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const feedbackEventSchema = Type.Object(
  {
    ...feedbackSourceEventSchema.properties,
    attempt: Type.Optional(
      Type.Object(
        {
          id: hash,
          sourceThreadId: Type.Optional(text),
          sourceTurnId: text,
          beforeTurnId: text,
          turnId: Type.Optional(text),
          request: Type.Object(
            {
              threadId: text,
              prompt: Type.String({ maxLength: 32000 }),
              model: Type.Optional(text),
              thinking: Type.Optional(text),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    publicationApproval: Type.Optional(
      Type.Object(
        { by: text, at: Type.Integer({ minimum: 0 }), digest: hash },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const codexFeedbackSchema = Type.Object(
  {
    ...feedbackSourceStateSchema.properties,
    events: Type.Array(feedbackEventSchema, { maxItems: 400 }),
  },
  { additionalProperties: false },
);
export type FeedbackEvent = Static<typeof feedbackEventSchema>;
export type CodexFeedback = Static<typeof codexFeedbackSchema>;
