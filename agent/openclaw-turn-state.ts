import { Type, type Static } from 'typebox';
const text = Type.String({ minLength: 1, maxLength: 4096 });
export const issueTurnSchema = Type.Object(
  {
    runId: text,
    message: Type.String({ minLength: 1, maxLength: 128000 }),
    status: Type.Union([
      Type.Literal('attempted'),
      Type.Literal('accepted'),
      Type.Literal('consumed'),
      Type.Literal('completed'),
    ]),
    inactive: Type.Optional(Type.Boolean()),
    consumedByEventId: Type.Optional(text),
    replyEventId: Type.Optional(text),
    executionModel: Type.Optional(text),
  },
  { additionalProperties: false },
);

export type OpenClawTurn = Static<typeof issueTurnSchema>;
