import { Type, type Static } from 'typebox';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const feedbackResultSchema = Type.Object(
  {
    privateText: Type.String({ minLength: 1, maxLength: 32000 }),
    publicText: Type.Optional(
      Type.String({ minLength: 1, maxLength: maximumGitHubNotificationReplyLength }),
    ),
  },
  { additionalProperties: false },
);
export const feedbackEventSchema = Type.Object(
  {
    id: hash,
    sourceId: text,
    number: Type.Integer({ minimum: 1 }),
    nodeId: text,
    itemType: Type.Union([Type.Literal('issue'), Type.Literal('pull-request')]),
    source: Type.String({ minLength: 1, maxLength: 128000 }),
    revision: hash,
    createdAt: Type.Integer({ minimum: 0 }),
    policyDigest: hash,
    resumed: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    previousTurnIds: Type.Optional(Type.Array(text, { maxItems: 3 })),
    phase: Type.Union([
      Type.Literal('queued'),
      Type.Literal('prepared'),
      Type.Literal('running'),
      Type.Literal('responded'),
      Type.Literal('published'),
      Type.Literal('blocked'),
    ]),
    attempt: Type.Optional(
      Type.Object(
        {
          id: hash,
          sourceTurnId: text,
          beforeTurnId: text,
          turnId: Type.Optional(text),
          request: Type.Object(
            {
              threadId: text,
              prompt: Type.String({ maxLength: 32000 }),
              model: text,
              thinking: text,
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    result: Type.Optional(feedbackResultSchema),
    replyRequested: Type.Optional(Type.Boolean()),
    composition: Type.Optional(assessmentSelectionSchema),
    publicationAttempted: Type.Optional(Type.Boolean()),
    publicationApproval: Type.Optional(
      Type.Object(
        { by: text, at: Type.Integer({ minimum: 0 }), digest: hash },
        { additionalProperties: false },
      ),
    ),
    receipt: Type.Optional(
      Type.Object(
        { nodeId: text, databaseId: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    reported: Type.Optional(Type.Boolean()),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const codexFeedbackSchema = Type.Object(
  {
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    scannedAt: Type.Optional(Type.String()),
    scannedTime: Type.Optional(Type.Integer({ minimum: 0 })),
    lastServedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    baseline: Type.Record(
      Type.String(),
      Type.Record(Type.String(), Type.String({ maxLength: 128000 })),
    ),
    events: Type.Array(feedbackEventSchema, { maxItems: 400 }),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type FeedbackEvent = Static<typeof feedbackEventSchema>;
export type CodexFeedback = Static<typeof codexFeedbackSchema>;
