import { Type, type Static } from 'typebox';
import { issueTurnSchema } from './openclaw-turn-state.ts';
import { deliveryPendingPushSchema, deliveryPullRequestSchema } from './delivery-state.ts';

const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const text = Type.String({ minLength: 1, maxLength: 4096 });
// Descriptive evidence only: terminal records cannot execute these effects again.
export const terminalEffectSchema = Type.Object(
  {
    kind: text,
    id: text,
    status: text,
    outcome: Type.Optional(text),
    sourceId: Type.Optional(text),
    revision: Type.Optional(text),
    nodeId: Type.Optional(text),
    attempt: Type.Optional(text),
    code: Type.Optional(text),
    hold: Type.Optional(text),
    reported: Type.Optional(Type.Boolean()),
    receipt: Type.Optional(
      Type.Object(
        { nodeId: text, databaseId: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    previewDigest: Type.Optional(hash),
    nativeDenial: Type.Optional(
      Type.Object(
        { turnId: text, callId: text, commandDigest: hash },
        { additionalProperties: false },
      ),
    ),
    repositoryId: Type.Optional(text),
    issueId: Type.Optional(text),
    branch: Type.Optional(text),
    head: Type.Optional(text),
    pushedHead: Type.Optional(text),
    pendingPush: Type.Optional(deliveryPendingPushSchema),
    contentDigest: Type.Optional(hash),
    pullRequest: Type.Optional(deliveryPullRequestSchema),
  },
  { additionalProperties: false },
);
export type TerminalEffect = Static<typeof terminalEffectSchema>;
export const historyReferenceSchema = Type.Object(
  { digest: hash, at: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
export const retainedHistorySchema = Type.Object(
  {
    entries: Type.Array(historyReferenceSchema),
    expired: Type.Optional(Type.Literal(true)),
    terminal: Type.Optional(Type.Literal(true)),
    outcome: Type.Optional(
      Type.Object(
        {
          assessment: text,
          implementation: text,
          code: Type.Optional(text),
          continuation: Type.Optional(text),
          turns: Type.Array(Type.Omit(issueTurnSchema, ['message', 'executionModel'])),
          assessments: Type.Array(
            Type.Object({ id: hash, outcome: text }, { additionalProperties: false }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    effects: Type.Optional(Type.Array(terminalEffectSchema)),
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
