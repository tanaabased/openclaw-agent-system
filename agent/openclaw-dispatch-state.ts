import { Type, type Static } from 'typebox';

import DispatchStore, { dispatchRecordProperties, type DispatchState } from './dispatch-state.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const issueTurnSchema = Type.Object(
  {
    runId: text,
    message: Type.String({ minLength: 1, maxLength: 128000 }),
    status: Type.Union([
      Type.Literal('attempted'),
      Type.Literal('accepted'),
      Type.Literal('consumed'),
      Type.Literal('completed'),
    ]),
    consumedByEventId: Type.Optional(text),
    replyEventId: Type.Optional(text),
    executionModel: Type.Optional(text),
  },
  { additionalProperties: false },
);

// retained only to read existing receipts and prevent duplicate issue sessions.
const legacyCreationSchema = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 128000 }),
    label: text,
    cwd: text,
    model: text,
    runtime: Type.Literal('subagent'),
    visible: Type.Literal(true),
    cleanup: Type.Literal('keep'),
    group: Type.Optional(text),
    expectsCompletionMessage: Type.Optional(Type.Literal(false)),
  },
  { additionalProperties: false },
);
const sessionCreationRequestSchema = Type.Object(
  {
    key: text,
    idempotencyKey: text,
    agentId: text,
    label: text,
    category: text,
    cwd: text,
    model: text,
    thinkingLevel: text,
  },
  { additionalProperties: false },
);
export const openclawDispatchRecordSchema = Type.Object(
  {
    ...dispatchRecordProperties,
    request: Type.Optional(Type.Union([legacyCreationSchema, sessionCreationRequestSchema])),
    sessionCreation: Type.Optional(
      Type.Object(
        {
          attempted: Type.Boolean(),
          sourceSessionId: text,
          sourceRunId: text,
          sourceToolCallId: text,
          sessionId: Type.Optional(text),
          verified: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: false },
      ),
    ),
    firstTurn: Type.Optional(issueTurnSchema),
    assessmentTurn: Type.Optional(issueTurnSchema),
    assessmentCaller: Type.Optional(
      Type.Object({ runId: text, inputEventId: text }, { additionalProperties: false }),
    ),
    creationCall: Type.Optional(
      Type.Object(
        {
          runId: text,
          sessionId: text,
          toolCallId: text,
        },
        { additionalProperties: false },
      ),
    ),
    blocker: Type.Optional(text),
    failureStage: Type.Optional(
      Type.Union([
        Type.Literal('validation'),
        Type.Literal('preflight'),
        Type.Literal('routing'),
        Type.Literal('worktree'),
        Type.Literal('assessment-skill'),
        Type.Literal('verification'),
        Type.Literal('session-create'),
        Type.Literal('first-turn'),
        Type.Literal('assessment-turn'),
      ]),
    ),
    setupComplete: Type.Optional(Type.Boolean()),
    setupObservation: Type.Optional(
      Type.Object(
        {
          sessionKey: text,
          sessionId: text,
          runId: text,
          success: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    continuation: Type.Optional(
      Type.Object(
        {
          message: text,
          issuedAt: Type.Integer({ minimum: 0 }),
          sourceRunId: Type.Optional(text),
          runId: Type.Optional(text),
          toolCallId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    execution: Type.Optional(
      Type.Object(
        {
          runId: text,
          model: text,
          effort: text,
        },
        { additionalProperties: false },
      ),
    ),
    native: Type.Optional(
      Type.Object(
        {
          sessionKey: text,
          sessionId: text,
          runId: text,
          sourceSessionId: text,
          toolCallId: text,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type OpenClawDispatchRecord = Static<typeof openclawDispatchRecordSchema>;
export type OpenClawDispatchState = DispatchState<OpenClawDispatchRecord>;

function validIssueTurn(turn: Static<typeof issueTurnSchema>, runId: string) {
  return (
    turn.runId === runId &&
    ['consumed', 'completed'].includes(turn.status) === Boolean(turn.consumedByEventId) &&
    (!turn.executionModel || turn.status === 'completed') &&
    (!turn.replyEventId || turn.status === 'completed') &&
    (turn.status !== 'completed' || Boolean(turn.replyEventId))
  );
}

export default class OpenClawDispatchStore extends DispatchStore<OpenClawDispatchRecord> {
  constructor(root: string, scope: string) {
    super(root, scope, {
      runtime: 'openclaw',
      recordSchema: openclawDispatchRecordSchema,
      validRecord: (record) => {
        if (record.request && 'key' in record.request) {
          return Boolean(
            record.sessionCreation &&
            record.worktree === record.request.cwd &&
            !record.native &&
            !record.creationCall &&
            !record.setupObservation &&
            !record.setupComplete &&
            !record.continuation &&
            !record.execution &&
            ['creating', 'created', 'assessing', 'complete', 'blocked'].includes(record.phase) &&
            (!record.sessionCreation.sessionId || record.sessionCreation.attempted) &&
            (!record.sessionCreation.verified ||
              (record.sessionCreation.sessionId &&
                record.threadId === record.request.key &&
                record.effective?.status === 'verified' &&
                record.effective.model === record.request.model &&
                record.effective.effort === record.request.thinkingLevel)) &&
            (!record.effective || record.sessionCreation.verified) &&
            (!record.firstTurn ||
              (record.sessionCreation.verified &&
                validIssueTurn(record.firstTurn, `${record.id}:first-turn`))) &&
            (!record.assessmentTurn ||
              (record.sessionCreation.verified &&
                record.assessment &&
                (!record.firstTurn || record.firstTurn.status === 'completed') &&
                validIssueTurn(record.assessmentTurn, `${record.id}:assessment`))) &&
            (!record.assessmentCaller || record.assessmentTurn) &&
            (!record.result ||
              (record.assessmentTurn &&
                record.assessmentCaller &&
                record.stageReceipt &&
                record.resultTurnId)) &&
            (!['assessing', 'complete'].includes(record.phase) || record.assessmentTurn) &&
            (record.phase !== 'created' || record.sessionCreation.verified),
          );
        }
        return (
          !record.sessionCreation &&
          !record.firstTurn &&
          !record.assessmentTurn &&
          !record.assessmentCaller &&
          record.phase !== 'created' &&
          (!record.request || record.worktree === record.request.cwd) &&
          (!record.creationCall || Boolean(record.request)) &&
          (!record.native ||
            Boolean(
              record.request &&
              record.creationCall &&
              record.threadId === record.native.sessionKey &&
              record.creationCall.sessionId === record.native.sourceSessionId &&
              record.creationCall.toolCallId === record.native.toolCallId,
            )) &&
          (!record.setupComplete ||
            Boolean(
              record.native &&
              record.setupObservation?.success &&
              record.setupObservation.sessionKey === record.native.sessionKey &&
              record.setupObservation.sessionId === record.native.sessionId &&
              record.setupObservation.runId === record.native.runId,
            )) &&
          (!record.continuation || Boolean(record.setupComplete && record.effective)) &&
          (!record.execution || Boolean(record.continuation?.runId && record.effective)) &&
          (!record.effective || Boolean(record.native && record.effective.status === 'verified')) &&
          (!['assessing', 'complete'].includes(record.phase) ||
            Boolean(
              record.native && record.effective && record.setupComplete && record.continuation,
            ))
        );
      },
    });
  }
}
