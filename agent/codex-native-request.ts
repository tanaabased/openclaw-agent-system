import { Type, type Static } from 'typebox';
const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const attemptSchema = Type.Object(
  {
    id: hash,
    origin: Type.Optional(Type.Union([Type.Literal('assessment'), Type.Literal('input')])),
    inputId: Type.Optional(text),
    sourceThreadId: Type.Optional(text),
    sourceTurnId: text,
    beforeTurnId: text,
    request: Type.Object(
      {
        threadId: text,
        prompt: Type.String({ minLength: 1, maxLength: 32000 }),
        model: Type.Optional(text),
        thinking: Type.Optional(text),
      },
      { additionalProperties: false },
    ),
    turnId: Type.Optional(text),
    ended: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const codexNativeRequestSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('implementation'),
      Type.Literal('delivery'),
      Type.Literal('decision'),
      Type.Literal('summary'),
    ]),
    attempt: attemptSchema,
  },
  { additionalProperties: false },
);
export type CodexNativeRequest = Static<typeof codexNativeRequestSchema>;
