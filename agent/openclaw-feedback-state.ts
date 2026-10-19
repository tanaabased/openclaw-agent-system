import { Type, type Static } from 'typebox';
import { feedbackSourceEventSchema, feedbackSourceStateSchema } from './feedback-state.ts';
import { openclawWorkStateSchema } from './openclaw-work-state.ts';
import { issueTurnSchema } from './openclaw-turn-state.ts';

export const openclawFeedbackEventSchema = Type.Object(
  {
    ...feedbackSourceEventSchema.properties,
    turn: Type.Optional(issueTurnSchema),
    repairWork: Type.Optional(openclawWorkStateSchema),
    contextInputId: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  },
  { additionalProperties: false },
);
export const openclawFeedbackSchema = Type.Object(
  {
    ...feedbackSourceStateSchema.properties,
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
