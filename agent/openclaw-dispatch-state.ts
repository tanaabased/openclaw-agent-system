import { Type, type Static } from 'typebox';
import { isDeepStrictEqual } from 'node:util';
import { stateSnapshotConflictCode } from '../core/merge-state-snapshot.ts';

import DispatchStore, { dispatchRecordProperties, type DispatchState } from './dispatch-state.ts';
import { issueTurnSchema, type OpenClawTurn } from './openclaw-turn-state.ts';
import { openclawFeedbackSchema } from './openclaw-feedback-state.ts';
import { openclawWorkStateSchema } from './openclaw-work-state.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
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
    work: Type.Optional(openclawWorkStateSchema),
    turnEvidence: Type.Optional(
      Type.Object(
        {
          runId: text,
          inputEventId: text,
          evidence: Type.String({ maxLength: 96000 }),
        },
        { additionalProperties: false },
      ),
    ),
    feedback: Type.Optional(openclawFeedbackSchema),
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
    decisionTurn: Type.Optional(issueTurnSchema),
    previousDecisionTurns: Type.Optional(Type.Array(issueTurnSchema)),
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
    (!turn.failed || turn.status === 'completed') &&
    (turn.status !== 'completed' || turn.failed || Boolean(turn.replyEventId))
  );
}

function validWorkTurns(record: OpenClawDispatchRecord) {
  const work = record.work;
  if (!work) return true;
  for (const slot of ['turn', 'deliveryTurn'] as const) {
    const prefix = `${record.id}:${slot === 'turn' ? 'implementation' : 'delivery'}`;
    const previous = (work.previousTurns ?? []).filter((entry) => entry.slot === slot);
    const expected = (index: number) => prefix + (index ? `:resume:${index}` : '');
    if (
      previous.some(
        ({ turn }, index) => turn.status !== 'completed' || !validIssueTurn(turn, expected(index)),
      )
    )
      return false;
    if (work[slot] && !validIssueTurn(work[slot], expected(previous.length))) return false;
  }
  return true;
}

export default class OpenClawDispatchStore extends DispatchStore<OpenClawDispatchRecord> {
  constructor(root: string, scope: string) {
    super(root, scope, {
      runtime: 'openclaw',
      recordSchema: openclawDispatchRecordSchema,
      validRecord: (record) => {
        if (record.request && 'key' in record.request) {
          return Boolean(
            (!record.feedback ||
              record.feedback.events.length === 0 ||
              (record.sessionCreation?.verified &&
                record.feedback.events.every((event) => {
                  const prefix = `${record.id}:feedback:${event.id}`;
                  const previous = event.previousTurnIds ?? [];
                  const expected = (index: number) => prefix + (index ? `:resume:${index}` : '');
                  return (
                    previous.length === (event.resumed ?? 0) &&
                    previous.every((id, index) => id === expected(index)) &&
                    (!event.turn || validIssueTurn(event.turn, expected(previous.length)))
                  );
                }))) &&
            (!record.work ||
              ((record.progression?.stage === 'implementation' ||
                (record.handoff && record.result?.outcome === 'plan-ready')) &&
                record.work.assessmentDigest === record.stageReceipt?.resultDigest &&
                validWorkTurns(record))) &&
            record.sessionCreation &&
            record.worktree === record.request.cwd &&
            !record.native &&
            !record.creationCall &&
            !record.setupObservation &&
            !record.setupComplete &&
            !record.continuation &&
            !record.execution &&
            [
              'creating',
              'created',
              'assessing',
              'complete',
              'blocked',
              'waiting',
              'retrying',
            ].includes(record.phase) &&
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
            (record.previousDecisionTurns ?? []).every(
              (turn, index) =>
                turn.status === 'completed' &&
                validIssueTurn(
                  turn,
                  `${record.id}:auto-decision${index ? ':resume:' + index : ''}`,
                ),
            ) &&
            (!record.decisionTurn ||
              (record.assessmentTurn?.status === 'completed' &&
                validIssueTurn(
                  record.decisionTurn,
                  `${record.id}:auto-decision${record.previousDecisionTurns?.length ? ':resume:' + record.previousDecisionTurns.length : ''}`,
                ))) &&
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
          (!record.feedback || (!record.request && record.feedback.events.length === 0)) &&
          !record.work &&
          !record.sessionCreation &&
          !record.firstTurn &&
          !record.assessmentTurn &&
          !record.decisionTurn &&
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

/** late transport acknowledgements must preserve progress already observed by the child. */
export function preserveOpenClawProgress(
  before: DispatchState<OpenClawDispatchRecord>,
  proposed: DispatchState<OpenClawDispatchRecord>,
  current: DispatchState<OpenClawDispatchRecord>,
): void {
  const statuses = ['attempted', 'accepted', 'consumed', 'completed'];
  const preserve = (previous?: OpenClawTurn, desired?: OpenClawTurn, fresh?: OpenClawTurn) => {
    if (
      previous &&
      desired &&
      fresh &&
      previous.runId === desired.runId &&
      desired.runId === fresh.runId &&
      statuses.indexOf(desired.status) > statuses.indexOf(previous.status) &&
      statuses.indexOf(fresh.status) > statuses.indexOf(desired.status)
    )
      desired.status = fresh.status;
  };
  for (const record of proposed.records) {
    const previous = before.records.find((entry) => entry.id === record.id);
    const fresh = current.records.find((entry) => entry.id === record.id);
    if (!previous || !fresh) continue;
    if (
      !isDeepStrictEqual(previous, record) &&
      (!isDeepStrictEqual(previous.work, fresh.work) ||
        (previous.result && !isDeepStrictEqual(previous.result, fresh.result)))
    )
      throw new Error(stateSnapshotConflictCode);
    if (fresh.result && record.phase === 'assessing') record.phase = 'complete';
    preserve(previous.firstTurn, record.firstTurn, fresh.firstTurn);
    preserve(previous.assessmentTurn, record.assessmentTurn, fresh.assessmentTurn);
    preserve(previous.decisionTurn, record.decisionTurn, fresh.decisionTurn);
    for (const event of record.feedback?.events ?? []) {
      const retained = fresh.feedback?.events.find((entry) => entry.id === event.id);
      if (
        event.phase === 'running' &&
        retained &&
        ['responded', 'published'].includes(retained.phase)
      )
        event.phase = retained.phase;
      preserve(
        previous.feedback?.events.find((entry) => entry.id === event.id)?.turn,
        event.turn,
        fresh.feedback?.events.find((entry) => entry.id === event.id)?.turn,
      );
    }
  }
}
