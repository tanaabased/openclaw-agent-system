import { Type, type Static } from 'typebox';
import { dispatchRetryProperties } from './dispatch-retry.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const feedbackSourceEventSchema = Type.Object(
  {
    ...dispatchRetryProperties,
    id: hash,
    sourceId: text,
    number: Type.Integer({ minimum: 1 }),
    nodeId: text,
    itemType: Type.Union([Type.Literal('issue'), Type.Literal('pull-request')]),
    source: Type.String({ minLength: 1 }),
    revision: hash,
    createdAt: Type.Integer({ minimum: 0 }),
    policyDigest: hash,
    policyHeld: Type.Optional(text),
    phase: Type.Union([
      Type.Literal('queued'),
      Type.Literal('prepared'),
      Type.Literal('running'),
      Type.Literal('delivered'),
      Type.Literal('blocked'),
    ]),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const feedbackSourceStateSchema = Type.Object(
  {
    completed: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: hash,
            sourceId: text,
            revision: hash,
            nodeId: text,
          },
          { additionalProperties: false },
        ),
      ),
    ),
    evaluatedPolicyDigests: Type.Optional(Type.Record(text, hash)),
    admission: Type.Optional(
      Type.Object(
        {
          enabled: Type.Boolean(),
          observedAt: Type.Integer({ minimum: 0 }),
          after: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    scannedAt: Type.Optional(Type.String()),
    scannedTime: Type.Optional(Type.Integer({ minimum: 0 })),
    discoveryPending: Type.Optional(Type.Boolean()),
    discoveryStalls: Type.Optional(
      Type.Record(
        text,
        Type.Object(
          {
            operation: text,
            attempts: Type.Integer({ minimum: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    lastSource: Type.Optional(text),
    lastServedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    discovery: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            since: Type.Integer({ minimum: 0 }),
            startedAt: Type.Integer({ minimum: 0 }),
            reads: Type.Record(Type.String(), Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    reviewMarkers: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 128000 }))),
    watermarks: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))),
    baseline: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),
    events: Type.Array(feedbackSourceEventSchema, { maxItems: 400 }),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type FeedbackSourceEvent = Static<typeof feedbackSourceEventSchema>;
export type FeedbackSourceState = Static<typeof feedbackSourceStateSchema>;
