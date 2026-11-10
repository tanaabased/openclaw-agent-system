import assert from 'node:assert/strict';
import nativeDispatchRecord, {
  validNativeDispatchRecord,
} from '../agent/native-dispatch-record.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import { refreshStateSnapshot } from '../core/merge-state-snapshot.ts';

const base = {
  id: 'a'.repeat(64),
  intakeId: 'b'.repeat(64),
  issueKey: 'c'.repeat(64),
  sourceThreadId: 'source',
  phase: 'routing' as const,
  createdAt: 1,
  manifestDigest: 'manifest',
};
const attempt = {
  id: 'd'.repeat(64),
  sourceTurnId: 'source-turn',
  beforeTurnId: 'before',
  request: { threadId: 'destination', prompt: 'exact pending request' },
};

describe('agent/native dispatch records', () => {
  it('should preserve pending requests exactly and let terminal evidence dominate older copies', () => {
    const source: DispatchRecord = {
      ...base,
      nativeRequests: [{ kind: 'summary', attempt }],
      previousSummaryAttempts: [{ ...attempt, ended: true }],
    };
    assert.equal(nativeDispatchRecord(source).nativeRequests, undefined);
    delete source.previousSummaryAttempts;
    assert.deepEqual(nativeDispatchRecord(source).nativeRequests, source.nativeRequests);
    assert.deepEqual(
      nativeDispatchRecord(nativeDispatchRecord(source)),
      nativeDispatchRecord(source),
    );
    source.previousSummaryAttempts = [
      { ...attempt, request: { ...attempt.request, prompt: 'different request' } },
    ];
    assert.throws(() => nativeDispatchRecord(source), /native-request-conflict/);
  });

  it('should preserve native turn custody and cancellation without retaining completed messages', () => {
    const turn = {
      runId: base.id + ':assessment',
      status: 'completed' as const,
      message: 'old controller text',
      consumedByEventId: 'input',
      replyEventId: 'reply',
      cancelled: true as const,
    };
    const source: OpenClawDispatchRecord = {
      ...base,
      sessionCreation: {
        attempted: true,
        sourceSessionId: 'source',
        sourceRunId: 'run',
        sourceToolCallId: 'call',
      },
      assessmentTurn: turn,
    };
    const migrated = nativeDispatchRecord(source);
    assert.equal(migrated.assessmentTurn, undefined);
    assert.deepEqual(migrated.nativeTurns, [
      {
        role: 'assessment',
        turn: {
          runId: turn.runId,
          status: 'completed',
          consumedByEventId: 'input',
          replyEventId: 'reply',
          cancelled: true,
        },
      },
    ]);
    assert.equal(validNativeDispatchRecord(migrated), true);
    migrated.assessmentTurn = { ...turn, consumedByEventId: 'different' };
    assert.throws(() => nativeDispatchRecord(migrated), /native-turn-conflict/);
  });

  it('should not silently erase an unreceipted external publication on ordinary saves', () => {
    const source: DispatchRecord = {
      ...base,
      feedback: {
        baseline: {},
        events: [
          {
            id: 'd'.repeat(64),
            sourceId: 'comment',
            nodeId: 'issue',
            number: 1,
            itemType: 'issue',
            source: '{}',
            revision: 'e'.repeat(64),
            createdAt: 1,
            policyDigest: 'f'.repeat(64),
            phase: 'responded',
            publicationAttempted: true,
          },
        ],
      },
    };
    assert.throws(() => nativeDispatchRecord(source), /external-effect-migration-required/);
    assert.equal(validNativeDispatchRecord({ ...source, nativeRecord: true }), false);
  });

  it('should refresh the same native request and turn references across intermediate saves', () => {
    const before = {
      nativeTurns: [{ role: 'assessment', turn: { runId: 'run', status: 'attempted' } }],
      nativeRequests: [{ kind: 'summary', attempt: structuredClone(attempt) }],
    };
    const turn = before.nativeTurns[0]!.turn;
    const request = before.nativeRequests[0]!.attempt;
    const saved = structuredClone(before);
    saved.nativeTurns[0]!.turn.status = 'accepted';
    refreshStateSnapshot(before, saved);
    assert.equal(before.nativeTurns[0]!.turn, turn);
    assert.equal(before.nativeRequests[0]!.attempt, request);
    turn.status = 'consumed';
    assert.equal(before.nativeTurns[0]!.turn.status, 'consumed');
  });
});
