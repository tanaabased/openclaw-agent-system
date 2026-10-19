import assert from 'node:assert/strict';

import recoverTaskBlockers from '../agent/recover-task-blockers.ts';

describe('agent/recover-task-blockers', () => {
  const record = () => ({
    request: { exact: 'original native request' },
    threadId: 'issue-chat',
    worktree: '/retained',
    effective: { status: 'verified' },
    phase: 'blocked',
    blocker: 'dispatch-policy-changed',
    continuation: {
      phase: 'blocked',
      code: 'continuation-authority-changed',
      attempt: { id: 'original-send' },
    },
  });
  it('should recover supported configuration blockers without replacing native identities or attempts', () => {
    const original = record();
    const expected = structuredClone(original);
    recoverTaskBlockers(original);
    assert.equal(original.phase, 'assessing');
    assert.equal(original.blocker, undefined);
    assert.equal(original.continuation.phase, 'prepared');
    assert.deepEqual(original.request, expected.request);
    assert.deepEqual(original.continuation.attempt, expected.continuation.attempt);
    assert.equal(original.threadId, expected.threadId);
    assert.equal(original.worktree, expected.worktree);
    const once = structuredClone(original);
    recoverTaskBlockers(original);
    assert.deepEqual(original, once);
  });
  it('should clear obsolete stage gates while preserving exact submission receipts', () => {
    for (const code of [
      'dispatch-operator-followup-required',
      'dispatch-handoff-user-turn-required',
      'dispatch-implementation-authorization-required',
      'delivery-human-publication-required',
      'feedback-work-authority-denied',
      'continuation-user-intervened',
      'continuation-selection-changed',
    ]) {
      const value = {
        ...record(),
        blocker: code,
        continuation: {
          phase: 'blocked',
          code,
          attempt: { id: 'sent-once' },
          binding: { turnId: 'original' },
        },
      };
      recoverTaskBlockers(value);
      assert.equal(value.blocker, undefined);
      assert.equal(value.continuation.phase, 'running');
      assert.deepEqual(value.continuation.attempt, { id: 'sent-once' });
      assert.deepEqual(value.continuation.binding, { turnId: 'original' });
    }
  });
  it('should preserve inactive tasks, explicit cancellation and native denial', () => {
    for (const inactive of [
      { retirement: { reason: 'assignment-removed' } },
      { retired: { at: 1 } },
      { reset: { at: 1 } },
    ]) {
      const value = { ...record(), ...inactive };
      const before = structuredClone(value);
      recoverTaskBlockers(value);
      assert.deepEqual(value, before);
    }
    for (const [phase, code] of [
      ['cancelled', 'continuation-authority-changed'],
      ['blocked', 'continuation-native-send-failed'],
    ] as const) {
      const value = {
        ...record(),
        blocker: 'native-approval-denied',
        continuation: { phase, code },
      };
      const before = structuredClone(value);
      recoverTaskBlockers(value);
      assert.deepEqual(value, before);
    }
  });
  it('should preserve questions and substantive stops when clearing an obsolete skill-content blocker', () => {
    for (const outcome of ['clarification-needed', 'blocked']) {
      const value = {
        ...record(),
        continuation: {
          phase: 'blocked',
          code: 'continuation-selection-changed',
          binding: { turnId: 'original' },
          result: { outcome, fullResult: 'Retained implementation output.' },
        },
      };
      const previous = structuredClone(value.continuation);
      recoverTaskBlockers(value);
      assert.equal(value.continuation.code, undefined);
      assert.equal(value.continuation.phase, outcome);
      assert.deepEqual(value.continuation.result, previous.result);
      assert.deepEqual(value.continuation.binding, previous.binding);
    }
  });
  it('should recover old interrupted feedback without discarding results or replaying writes', () => {
    for (const code of [
      'feedback-composition-interrupted',
      'feedback-publication-interrupted',
      'feedback-turn-ended',
      'github-notification-request-failed',
      'github-account-credential-unavailable',
    ]) {
      const event = {
        phase: 'blocked',
        code,
        attempt: { turnId: 'old-turn' },
        result: { privateText: 'Retained answer' },
        publicationAttempted: true,
      };
      const value = { ...record(), feedback: { events: [event] } };
      recoverTaskBlockers(value);
      assert.equal(event.phase, 'responded');
      assert.equal(event.publicationAttempted, true);
      assert.equal(event.attempt.turnId, 'old-turn');
      assert.equal(event.result.privateText, 'Retained answer');
    }
    const denied = {
      ...record(),
      feedback: { events: [{ phase: 'blocked', code: 'continuation-native-approval-denied' }] },
    };
    recoverTaskBlockers(denied);
    assert.equal(denied.feedback.events[0]!.phase, 'blocked');
  });
  it('should retain uncertain feedback publication for reconciliation instead of sending again', () => {
    const value = {
      ...record(),
      feedback: {
        events: [
          { phase: 'blocked', code: 'feedback-authority-changed', publicationAttempted: true },
        ],
      },
    };
    recoverTaskBlockers(value);
    assert.equal(value.feedback.events[0]!.phase, 'responded');
    assert.equal(value.feedback.events[0]!.publicationAttempted, true);
  });
});
