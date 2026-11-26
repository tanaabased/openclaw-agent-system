import { Type, type Static } from 'typebox';
import { codexWorkStateSchema } from '../implementation/codex-work-state.ts';

import { codexFeedbackSchema, feedbackEventSchema } from '../feedback/codex-feedback-state.ts';
import DispatchStore, {
  type DispatchPersistence,
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
    target: Type.Union([
      Type.Object({ type: Type.Literal('projectless') }, { additionalProperties: false }),
      Type.Object(
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
    ]),
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
    // Provider evidence and exact native send receipts, never reviewer progress or reasoning.
    reviewInput: Type.Optional(feedbackEventSchema.properties.attempt),
    creationFailure: Type.Optional(
      Type.Object(
        {
          count: Type.Integer({ minimum: 1, maximum: 3 }),
          model: text,
          thinking: text,
          message: text,
          terminal: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    creationRecovery: Type.Optional(
      Type.Object(
        {
          attempts: Type.Integer({ minimum: 0 }),
          denialRecovered: Type.Optional(Type.Literal(true)),
          latest: Type.Optional(
            Type.Object(
              {
                kind: Type.Union([
                  Type.Literal('denied'),
                  Type.Literal('unsubmitted'),
                  Type.Literal('rejected'),
                ]),
                turnId: text,
                callId: Type.Optional(text),
                approvedBy: Type.Optional(text),
                createdAt: Type.Optional(Type.Integer({ minimum: 0 })),
                recoveredAt: Type.Integer({ minimum: 0 }),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    nativeWork: Type.Optional(codexWorkStateSchema),
    preparationObservation: Type.Optional(preparationObservationSchema),
    denial: Type.Optional(intakeDenialSchema),
    claimId: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    claimPass: Type.Optional(text),
    claimAccepted: Type.Optional(Type.Boolean()),
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
    clientThreadId: Type.Optional(text),
    receiptThreadId: Type.Optional(text),
    feedback: Type.Optional(codexFeedbackSchema),
  },
  { additionalProperties: false },
);
export type DispatchRecord = Static<typeof dispatchRecordSchema>;
export type DispatchState = SharedDispatchState<DispatchRecord>;

export default class CodexDispatchStore extends DispatchStore<DispatchRecord> {
  constructor(scope: string, persistence: DispatchPersistence<DispatchRecord>) {
    super(scope, {
      persistence,
      runtime: 'codex',
      recordSchema: dispatchRecordSchema,
      validRecord: (record) =>
        (!record.issueBranch || record.issueBranch.attemptId === record.id) &&
        (!record.request ||
          (record.request.target.type === 'projectless'
            ? Boolean(record.reviewAdmission && !record.project && !record.worktree)
            : Boolean(record.project))) &&
        (!record.claimAccepted || Boolean(record.claimId && record.effective && record.threadId)),
    });
  }
}
