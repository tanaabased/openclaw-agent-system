import { Type, type Static } from 'typebox';

import { codexFeedbackSchema } from './codex-feedback-state.ts';

import { codexContinuationStateSchema, attemptSchema } from './codex-continuation-state.ts';
import { codexDeliveryStateSchema } from './codex-delivery-state.ts';
import DispatchStore, {
  dispatchRecordProperties,
  type DispatchState as SharedDispatchState,
} from './dispatch-state.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
export const dispatchProjectSchema = Type.Object(
  {
    id: text,
    path: text,
    commonDir: text,
    ref: text,
    commit: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
  },
  { additionalProperties: false },
);
export type DispatchProject = Static<typeof dispatchProjectSchema>;
const creationSchema = Type.Object(
  {
    title: text,
    prompt: Type.String({ minLength: 1, maxLength: 128000 }),
    model: text,
    thinking: text,
    target: Type.Object(
      {
        type: Type.Literal('project'),
        projectId: text,
        environment: Type.Object(
          {
            type: Type.Literal('worktree'),
            startingState: Type.Object(
              { type: Type.Literal('branch'), branchName: text },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const preparationObservationSchema = Type.Object(
  {
    sourceThreadId: text,
    turnId: text,
    intakeId: text,
    digest: text,
    afterItemId: text,
    at: Type.Integer({ minimum: 0 }),
    runtime: Type.Object(
      {
        nodeExecutable: text,
        nodeVersion: Type.Optional(text),
        nodeCommand: Type.Optional(Type.Literal('node')),
        entrypoint: text,
        pluginData: text,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type PreparationObservation = Static<typeof preparationObservationSchema>;
export const intakeDenialSchema = Type.Object(
  {
    sourceThreadId: text,
    turnId: text,
    callId: text,
    operation: Type.Union([Type.Literal('prepare'), Type.Literal('create')]),
    automatic: Type.Boolean(),
    reason: Type.Optional(text),
    observedAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type IntakeDenial = Static<typeof intakeDenialSchema>;
export const dispatchRecordSchema = Type.Object(
  {
    ...dispatchRecordProperties,
    preparationObservation: Type.Optional(preparationObservationSchema),
    implementationPreparationError: Type.Optional(text),
    denial: Type.Optional(intakeDenialSchema),
    recoveredDenials: Type.Optional(
      Type.Array(
        Type.Object(
          {
            denial: intakeDenialSchema,
            observation: Type.Optional(preparationObservationSchema),
            recoveredAt: Type.Integer({ minimum: 0 }),
            approvedBy: text,
          },
          { additionalProperties: false },
        ),
      ),
    ),
    claimId: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    claimPass: Type.Optional(text),
    claimAccepted: Type.Optional(Type.Boolean()),
    previousSummaryAttempts: Type.Optional(Type.Array(attemptSchema)),
    summaryRecovery: Type.Optional(
      Type.Object(
        {
          revision: Type.Integer({ minimum: 1 }),
          attempt: attemptSchema,
          ended: Type.Optional(Type.Literal(true)),
          code: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    autoDecision: Type.Optional(
      Type.Object(
        {
          attempt: attemptSchema,
          ended: Type.Optional(Type.Literal(true)),
          previousAttempts: Type.Optional(Type.Array(attemptSchema)),
          code: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    reservationVersion: Type.Optional(Type.Literal(1)),
    capacityObservation: Type.Optional(
      Type.Object(
        {
          at: Type.Integer({ minimum: 0 }),
          code: text,
          threadId: Type.Optional(text),
          turnId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    issueMode: Type.Optional(
      Type.Union([Type.Literal('plan'), Type.Literal('work'), Type.Literal('auto')]),
    ),
    project: Type.Optional(dispatchProjectSchema),
    issueBranch: Type.Optional(
      Type.Object(
        {
          attemptId: Type.String({ pattern: '^[a-f0-9]{64}$' }),
          name: text,
          phase: Type.Union([
            Type.Literal('planned'),
            Type.Literal('creating'),
            Type.Literal('ready'),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
    repositoryPreparation: Type.Optional(
      Type.Object(
        {
          path: text,
          source: text,
          identity: text,
          checkout: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    request: Type.Optional(creationSchema),
    preparationTurnId: Type.Optional(text),
    creationAfterItemId: Type.Optional(text),
    unsubmittedCreations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            request: creationSchema,
            createdAt: Type.Integer({ minimum: 0 }),
            recoveredAt: Type.Integer({ minimum: 0 }),
            continuation: Type.Optional(codexContinuationStateSchema),
            turnId: text,
          },
          { additionalProperties: false },
        ),
      ),
    ),
    deniedCreations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            request: creationSchema,
            createdAt: Type.Integer({ minimum: 0 }),
            recoveredAt: Type.Integer({ minimum: 0 }),
            turnId: text,
            callId: text,
            continuation: Type.Optional(codexContinuationStateSchema),
            approvedBy: Type.Optional(text),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    clientThreadId: Type.Optional(text),
    receiptThreadId: Type.Optional(text),
    delivery: Type.Optional(codexDeliveryStateSchema),
    deliveryHistory: Type.Optional(Type.Array(codexDeliveryStateSchema)),
    continuation: Type.Optional(codexContinuationStateSchema),
    feedback: Type.Optional(codexFeedbackSchema),
    renameRequested: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type DispatchRecord = Static<typeof dispatchRecordSchema>;
export type DispatchState = SharedDispatchState<DispatchRecord>;

export default class CodexDispatchStore extends DispatchStore<DispatchRecord> {
  constructor(root: string, scope: string) {
    super(root, scope, {
      runtime: 'codex',
      recordSchema: dispatchRecordSchema,
      validRecord: (record) =>
        (!record.issueBranch || record.issueBranch.attemptId === record.id) &&
        (!record.request || Boolean(record.project && record.reservationVersion === 1)) &&
        (!(
          record.continuation?.attempt ||
          record.continuation?.binding ||
          record.continuation?.result
        ) ||
          record.progression?.stage === 'implementation') &&
        (!record.claimAccepted || Boolean(record.claimId && record.effective && record.threadId)),
    });
  }
}
