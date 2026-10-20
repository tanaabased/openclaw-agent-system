import { feedbackDecisionSchema } from './feedback-work.ts';
import { implementationResultSchema } from './implementation-result.ts';
import { dispatchRetryProperties } from './dispatch-retry.ts';
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
export const feedbackSourceEventSchema = Type.Object(
  {
    ...dispatchRetryProperties,
    resumed: Type.Optional(Type.Integer({ minimum: 0 })),
    previousTurnIds: Type.Optional(Type.Array(text)),
    id: hash,
    sourceId: text,
    number: Type.Integer({ minimum: 1 }),
    nodeId: text,
    itemType: Type.Union([Type.Literal('issue'), Type.Literal('pull-request')]),
    source: Type.String({ minLength: 1, maxLength: 128000 }),
    revision: hash,
    createdAt: Type.Integer({ minimum: 0 }),
    policyDigest: hash,
    policyHeld: Type.Optional(text),
    phase: Type.Union([
      Type.Literal('queued'),
      Type.Literal('prepared'),
      Type.Literal('running'),
      Type.Literal('responded'),
      Type.Literal('published'),
      Type.Literal('blocked'),
    ]),
    work: Type.Optional(
      Type.Object(
        {
          selection: assessmentSelectionSchema,
          decision: Type.Optional(feedbackDecisionSchema),
          result: Type.Optional(implementationResultSchema),
          head: Type.Optional(Type.String({ pattern: '^[a-f0-9]{40,64}$' })),
          pullRequest: Type.Optional(
            Type.Object(
              { pullRequestNodeId: text, pullRequestNumber: Type.Integer({ minimum: 1 }) },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
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
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export const feedbackSourceStateSchema = Type.Object(
  {
    evaluatedPolicyDigests: Type.Optional(Type.Record(text, hash)),
    admission: Type.Optional(
      Type.Object(
        {
          enabled: Type.Boolean(),
          observedAt: Type.Optional(Type.Integer({ minimum: 0 })),
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
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type FeedbackSourceEvent = Static<typeof feedbackSourceEventSchema>;
export type FeedbackSourceState = Static<typeof feedbackSourceStateSchema>;
