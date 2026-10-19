import { dispatchRetryProperties } from './dispatch-retry.ts';
import { Type, type Static } from 'typebox';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';
import { retainedEvidenceSchema, retainedHistoryLimit } from './retained-history.ts';

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
export const feedbackSourceEventSchema = Type.Object(
  {
    ...dispatchRetryProperties,
    id: hash,
    sourceId: text,
    number: Type.Integer({ minimum: 1 }),
    nodeId: text,
    itemType: Type.Union([Type.Literal('issue'), Type.Literal('pull-request')]),
    source: Type.String({ minLength: 1, maxLength: 128000 }),
    revision: hash,
    createdAt: Type.Integer({ minimum: 0 }),
    policyDigest: hash,
    phase: Type.Union([
      Type.Literal('queued'),
      Type.Literal('prepared'),
      Type.Literal('running'),
      Type.Literal('responded'),
      Type.Literal('published'),
      Type.Literal('blocked'),
    ]),
    result: Type.Optional(feedbackResultSchema),
    replyRequested: Type.Optional(Type.Boolean()),
    composition: Type.Optional(assessmentSelectionSchema),
    publicationAttempted: Type.Optional(Type.Boolean()),
    receipt: Type.Optional(
      Type.Object(
        { nodeId: text, databaseId: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    reported: Type.Optional(Type.Boolean()),
    nativeCompleted: Type.Optional(Type.Literal(true)),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const feedbackSourceStateSchema = Type.Object(
  {
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    scannedAt: Type.Optional(Type.String()),
    scannedTime: Type.Optional(Type.Integer({ minimum: 0 })),
    discoveryPending: Type.Optional(Type.Boolean()),
    lastSource: Type.Optional(text),
    lastServedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    discovery: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            since: Type.Integer({ minimum: 0 }),
            startedAt: Type.Integer({ minimum: 0 }),
            reads: Type.Record(Type.String(), Type.String({ maxLength: 512000 })),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    reviewMarkers: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 128000 }))),
    watermarks: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
    baseline: Type.Record(
      Type.String(),
      Type.Record(Type.String(), Type.String({ maxLength: 128000 })),
    ),
    events: Type.Array(feedbackSourceEventSchema, { maxItems: 400 }),
    history: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: hash,
            sourceId: text,
            nodeId: text,
            revision: hash,
            turnId: Type.Optional(text),
            receipt: feedbackSourceEventSchema.properties.receipt,
            evidence: retainedEvidenceSchema,
          },
          { additionalProperties: false },
        ),
        { maxItems: retainedHistoryLimit },
      ),
    ),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type FeedbackSourceEvent = Static<typeof feedbackSourceEventSchema>;
export type FeedbackSourceState = Static<typeof feedbackSourceStateSchema>;
