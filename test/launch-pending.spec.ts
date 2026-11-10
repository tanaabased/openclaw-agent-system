import assert from 'node:assert/strict';
import launchPending from '../agent/launch-pending.ts';

describe('agent/launch-pending', () => {
  it('should finish codex launch on verified native creation without a saved assessment', () => {
    assert.equal(launchPending({}), true);
    assert.equal(launchPending({ threadId: 'native-chat' }), false);
  });
  it('should keep openclaw launch pending only until assessment dispatch is accepted', () => {
    const record = { threadId: 'native-chat', sessionCreation: { verified: true as const } };
    assert.equal(launchPending(record), true);
    for (const status of ['accepted', 'consumed', 'completed'])
      assert.equal(
        launchPending({
          ...record,
          nativeTurns: [{ role: 'assessment', turn: { runId: 'run', status } }],
        }),
        false,
      );
    assert.equal(
      launchPending({
        ...record,
        nativeTurns: [{ role: 'assessment', turn: { runId: 'run', status: 'attempted' } }],
      }),
      true,
    );
  });
});
