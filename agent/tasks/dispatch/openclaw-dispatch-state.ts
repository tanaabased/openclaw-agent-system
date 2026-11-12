import { isDeepStrictEqual } from 'node:util';
import { Type, type Static } from 'typebox';
import { stateSnapshotConflictCode } from '../../../core/merge-state-snapshot.ts';
import { nativeTurnSchema } from '../../openclaw-native-turns.ts';

import DispatchStore, { dispatchRecordProperties, type DispatchState } from './dispatch-state.ts';
import { openclawFeedbackSchema } from '../feedback/openclaw-feedback-state.ts';
import { type OpenClawTurn } from '../../openclaw-turn-state.ts';
import { openclawWorkStateSchema } from '../implementation/openclaw-work-state.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
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
    nativeTurns: Type.Optional(Type.Array(nativeTurnSchema)),
    adoptedLocalBranch: Type.Optional(text),
    separateCheckout: Type.Optional(Type.Literal(true)),
    worktreeAttemptId: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    work: Type.Optional(openclawWorkStateSchema),
    feedback: Type.Optional(openclawFeedbackSchema),
    request: Type.Optional(sessionCreationRequestSchema),
    claimId: Type.Optional(Type.Integer({ minimum: 1 })),
    claimAccepted: Type.Optional(Type.Boolean()),
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
    assessmentCaller: Type.Optional(
      Type.Object({ runId: text, inputEventId: text }, { additionalProperties: false }),
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
        Type.Literal('assessment-turn'),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type OpenClawDispatchRecord = Static<typeof openclawDispatchRecordSchema>;
export type OpenClawDispatchState = DispatchState<OpenClawDispatchRecord>;

export default class OpenClawDispatchStore extends DispatchStore<OpenClawDispatchRecord> {
  constructor(root: string, scope: string) {
    super(root, scope, {
      runtime: 'openclaw',
      recordSchema: openclawDispatchRecordSchema,
      validRecord: (record) => {
        if (!validNativeTurns(record)) return false;
        if (record.worktreeAttemptId && record.worktreeAttemptId !== record.id) return false;
        if (record.claimAccepted && (!record.claimId || !record.sessionCreation?.verified))
          return false;
        if (record.request) {
          return Boolean(
            record.sessionCreation &&
            record.worktree === record.request.cwd &&
            (!record.sessionCreation.sessionId || record.sessionCreation.attempted) &&
            (!record.sessionCreation.verified ||
              (record.sessionCreation.sessionId &&
                record.threadId === record.request.key &&
                record.effective)) &&
            (!record.effective || record.sessionCreation.verified),
          );
        }
        return Boolean(
          (!record.feedback || record.feedback.events.length === 0) &&
          !record.work &&
          !record.sessionCreation &&
          !record.assessmentCaller &&
          !record.effective,
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
    if (!isDeepStrictEqual(previous, record) && !isDeepStrictEqual(previous.work, fresh.work))
      throw new Error(stateSnapshotConflictCode);
    for (const event of record.feedback?.events ?? []) {
      preserve(
        previous.feedback?.events.find((entry) => entry.id === event.id)?.turn,
        event.turn,
        fresh.feedback?.events.find((entry) => entry.id === event.id)?.turn,
      );
    }
  }
}

function validNativeTurns(record: OpenClawDispatchRecord) {
  const turns = record.nativeTurns ?? [];
  return (
    new Set(turns.map(({ turn }) => turn.runId)).size === turns.length &&
    turns.every(
      ({ role, turn }) =>
        role !== 'feedback' &&
        (turn.status === 'completed' ? turn.message === undefined : Boolean(turn.message)) &&
        ['consumed', 'completed'].includes(turn.status) === Boolean(turn.consumedByEventId) &&
        (!turn.replyEventId || turn.status === 'completed') &&
        (!turn.executionModel || turn.status === 'completed') &&
        (!turn.failed || turn.status === 'completed') &&
        (turn.status !== 'completed' || turn.failed || Boolean(turn.replyEventId)),
    )
  );
}
