import assert from 'node:assert/strict';
import codexFeedbackInput from '../agent/codex-feedback-input.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';

function fixture() {
  return [
    {
      id: 'issue',
      threadId: 'chat',
      sourceThreadId: 'intake',
      continuation: { phase: 'cancelled' },
      feedback: {
        events: [
          { id: 'old', native: true, attempt: { id: 'old' } },
          { id: 'current', native: true, attempt: { id: 'current', turnId: 'current-turn' } },
        ],
      },
    },
  ] as unknown as DispatchRecord[];
}

describe('agent/codex-feedback-input', () => {
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
