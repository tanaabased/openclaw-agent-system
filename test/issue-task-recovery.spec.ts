import assert from 'node:assert/strict';
import type { FeedbackEvent } from '../agent/codex-feedback-state.ts';
import type { OpenClawFeedbackEvent } from '../agent/openclaw-feedback-state.ts';
import { pendingRecoveryFeedback } from '../agent/issue-task-recovery.ts';

describe('task replacement feedback protection', () => {
  const stale: FeedbackEvent = {
    id: 'a'.repeat(64),
    sourceId: 'comment',
    number: 1,
    nodeId: 'issue',
    itemType: 'issue',
    source: '{}',
    revision: 'b'.repeat(64),
    createdAt: 1,
    phase: 'blocked',
    code: 'feedback-source-changed',
  };

  it('releases only unsent invalidated revisions while preserving live input and denials', () => {
    assert.equal(pendingRecoveryFeedback(stale), false);
    assert.equal(pendingRecoveryFeedback({ ...stale, code: 'feedback-own-output' }), false);
    for (const phase of ['queued', 'prepared', 'running'] as const)
      assert.equal(pendingRecoveryFeedback({ ...stale, phase }), true);
    for (const code of [
      undefined,
      'feedback-source-owner-changed',
      'feedback-source-identity-changed',
      'feedback-native-binding-mismatch',
      'dispatch-native-denied',
      'feedback-send-unresolved',
    ])
      assert.equal(pendingRecoveryFeedback({ ...stale, code }), true);
    assert.equal(
      pendingRecoveryFeedback({ ...stale, phase: 'queued', policyHeld: 'feedback-not-approved' }),
      true,
    );
  });

  it('preserves uncertain sends in both runtimes even after source invalidation', () => {
    const codex: FeedbackEvent = {
      ...stale,
      attempt: {
        id: 'c'.repeat(64),
        sourceTurnId: 'coordinator-turn',
        beforeTurnId: 'previous',
        request: { threadId: 'issue-chat', prompt: 'original input' },
      },
    };
    const openclaw: OpenClawFeedbackEvent = {
      ...stale,
      turn: { runId: 'send', message: 'original input', status: 'attempted' },
    };
    for (const event of [codex, openclaw]) {
      assert.equal(pendingRecoveryFeedback(event), true);
      assert.equal(pendingRecoveryFeedback({ ...event, code: 'feedback-own-output' }), true);
      assert.equal(pendingRecoveryFeedback({ ...event, phase: 'delivered' }), false);
    }
  });
});
