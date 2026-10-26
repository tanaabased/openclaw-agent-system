import { Type, type Static } from 'typebox';

const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const text = Type.String({ minLength: 1, maxLength: 4096 });
export const historyReferenceSchema = Type.Object(
  { digest: hash, at: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
export const retainedHistorySchema = Type.Object(
  {
    entries: Type.Array(historyReferenceSchema),
    expired: Type.Optional(Type.Literal(true)),
    terminal: Type.Optional(Type.Literal(true)),
    sessionId: Type.Optional(text),
    pullRequest: Type.Optional(
      Type.Object(
        { pullRequestNodeId: text, pullRequestNumber: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type HistoryReference = Static<typeof historyReferenceSchema>;
export const historySoftBytes = 2 * 1024 * 1024;
export const historyMaximumBytes = 64 * 1024 * 1024;
export const historyLifetimeMs = 30 * 24 * 60 * 60 * 1000;
