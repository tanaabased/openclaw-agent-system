import assert from 'node:assert/strict';
import launchPending from '../agent/launch-pending.ts';

describe('agent/launch-pending', () => {
  it('should recognize accepted migrated launch receipts without the legacy turn slot', () => {
    const record = {
      threadId: 'issue',
      sessionCreation: { verified: true as const },
      nativeTurns: [{ role: 'assessment', turn: { runId: 'run', status: 'accepted' } }],
    };
    assert.equal(launchPending(record), false);
    record.nativeTurns[0]!.turn.status = 'attempted';
    assert.equal(launchPending(record), true);
  });
  it('should finish codex launch on verified native creation without a saved assessment', () => {
    assert.equal(launchPending({}), true);
    assert.equal(launchPending({ threadId: 'native-chat' }), false);
  });
  it('should keep openclaw launch pending only until assessment dispatch is accepted', () => {
    const record = { threadId: 'native-chat', sessionCreation: { verified: true as const } };
    assert.equal(launchPending(record), true);
    for (const status of ['accepted', 'consumed', 'completed'])
      assert.equal(launchPending({ ...record, assessmentTurn: { runId: 'run', status } }), false);
    assert.equal(
      launchPending({ ...record, assessmentTurn: { runId: 'run', status: 'attempted' } }),
      true,
    );
  });
});
