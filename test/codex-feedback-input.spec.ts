import assert from 'node:assert/strict';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import codexFeedbackInput from '../agent/tasks/feedback/codex-feedback-input.ts';

function fixture() {
  return [
    {
      id: 'issue',
      threadId: 'chat',
      sourceThreadId: 'intake',
      nativeWork: {},
      feedback: {
        events: [
          { id: 'old', attempt: { id: 'old' } },
          { id: 'current', attempt: { id: 'current', turnId: 'current-turn' } },
        ],
      },
    },
  ] as unknown as DispatchRecord[];
}

describe('agent/codex-feedback-input', () => {
  for (const outcome of ['verified', 'denied', 'changed', 'foreign'] as const)
    it(`should verify an explicitly selected earlier input with ${outcome} native custody`, async () => {
      const records = fixture();
      const attempt = records[0]!.feedback!.events[1]!.attempt!;
      attempt.request = {
        threadId: outcome === 'foreign' ? 'other-chat' : 'chat',
        prompt: 'original feedback',
      };
      const read = () =>
        codexFeedbackInput(
          records,
          'chat',
          'operator-retry',
          async () =>
            outcome === 'denied'
              ? {
                  status: 'blocked',
                  code: 'continuation-native-approval-denied',
                  turnId: 'current-turn',
                  ended: true,
                }
              : {
                  status: 'verified',
                  turnId: outcome === 'changed' ? 'different-turn' : 'current-turn',
                  ended: true,
                },
          'current',
        );
      if (outcome === 'verified') assert.equal((await read())?.event.id, 'current');
      else
        await assert.rejects(
          read(),
          /continuation-native-approval-denied|feedback-turn-changed|feedback-native-binding-mismatch/,
        );
      assert.equal(attempt.turnId, 'current-turn');
    });
  it('should accept current feedback despite cancelled implementation and an unrelated rejected send', async () => {
    const result = await codexFeedbackInput(
      fixture(),
      'chat',
      'current-turn',
      async (_source, attempt) =>
        attempt.id === 'old'
          ? { status: 'blocked', code: 'continuation-native-send-failed' }
          : { status: 'verified', turnId: 'current-turn', ended: false },
    );
    assert.equal(result?.event.id, 'current');
  });

  it('should isolate an unavailable old receipt from verified current input', async () => {
    const result = await codexFeedbackInput(
      fixture(),
      'chat',
      'current-turn',
      async (_source, attempt) => {
        if (attempt.id === 'old') throw new Error('old history is unavailable');
        return { status: 'verified', turnId: 'current-turn', ended: false };
      },
    );
    assert.equal(result?.event.id, 'current');
  });

  it('should retain a denial belonging to the current native turn', async () => {
    await assert.rejects(
      codexFeedbackInput(fixture(), 'chat', 'current-turn', async () => ({
        status: 'blocked',
        code: 'continuation-native-approval-denied',
        turnId: 'current-turn',
        ended: false,
      })),
      /continuation-native-approval-denied/,
    );
  });
  it('should retain an exact attempted-turn denial even when the error omits its turn id', async () => {
    await assert.rejects(
      codexFeedbackInput(fixture(), 'chat', 'current-turn', async (_source, attempt) =>
        attempt.id === 'old'
          ? { status: 'uncertain' }
          : { status: 'blocked', code: 'continuation-native-approval-denied' },
      ),
      /continuation-native-approval-denied/,
    );
  });
});
