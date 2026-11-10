import assert from 'node:assert/strict';
import { refreshStateSnapshot } from '../core/merge-state-snapshot.ts';
const attempt = {
  id: 'd'.repeat(64),
  sourceTurnId: 'source-turn',
  beforeTurnId: 'before',
  request: { threadId: 'destination', prompt: 'exact pending request' },
};

describe('core/native receipt references', () => {
  it('should refresh the same native request and turn references across intermediate saves', () => {
    const before = {
      nativeTurns: [{ role: 'assessment', turn: { runId: 'run', status: 'attempted' } }],
      feedback: { events: [{ id: 'event', attempt: structuredClone(attempt) }] },
    };
    const turn = before.nativeTurns[0]!.turn;
    const request = before.feedback.events[0]!.attempt;
    const saved = structuredClone(before);
    saved.nativeTurns[0]!.turn.status = 'accepted';
    refreshStateSnapshot(before, saved);
    assert.equal(before.nativeTurns[0]!.turn, turn);
    assert.equal(before.feedback.events[0]!.attempt, request);
    turn.status = 'consumed';
    assert.equal(before.nativeTurns[0]!.turn.status, 'consumed');
  });
});
