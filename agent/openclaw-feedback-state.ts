import { Type, type Static } from 'typebox';
import { feedbackSourceEventSchema, feedbackSourceStateSchema } from './feedback-state.ts';
import { issueTurnSchema } from './openclaw-turn-state.ts';

export const openclawFeedbackEventSchema = Type.Object(
  {
    ...feedbackSourceEventSchema.properties,
    turn: Type.Optional(issueTurnSchema),
  },
  { additionalProperties: false },
);
export const openclawFeedbackSchema = Type.Object(
  {
    ...feedbackSourceStateSchema.properties,
    context: Type.Optional(
      Type.Object(
        {
          runId: Type.String({ minLength: 1, maxLength: 4096 }),
          eventId: Type.String({ pattern: '^[a-f0-9]{64}$' }),
          inputEventId: Type.String({ minLength: 1, maxLength: 4096 }),
        },
        { additionalProperties: false },
      ),
    ),
    activity: Type.Optional(
      Type.Object(
        { busy: Type.Boolean(), observedAt: Type.Integer({ minimum: 0 }) },
        { additionalProperties: false },
      ),
    ),
    events: Type.Array(openclawFeedbackEventSchema, { maxItems: 400 }),
  },
  { additionalProperties: false },
);
export type OpenClawFeedbackEvent = Static<typeof openclawFeedbackEventSchema>;
