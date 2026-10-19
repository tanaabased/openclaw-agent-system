import assert from 'node:assert/strict';

import issueProgression, { retainedIssueProgression } from '../agent/issue-progression.ts';

const planning = { createdAt: 10, result: { outcome: 'plan-ready' } };

describe('agent/issue-progression', () => {
  it('should use live mode only to select the planning-to-implementation transition', () => {
    assert.deepEqual(issueProgression(planning, { mode: 'plan', now: 20 }), {
      status: 'held',
      reason: 'implementation-disabled',
    });
    assert.deepEqual(issueProgression(planning, { mode: 'work', now: 20 }), {
      status: 'ready',
      progression: { stage: 'implementation', via: 'work', enteredAt: 20 },
    });
    assert.deepEqual(issueProgression(planning, { mode: 'auto', now: 20 }), {
      status: 'held',
      reason: 'auto-decision-required',
    });
    for (const action of ['wait', 'proceed'] as const) {
      const issue = { ...planning, result: { ...planning.result, decision: { action } } };
      assert.equal(
        issueProgression(issue, { mode: 'auto', now: 20 }).status,
        action === 'proceed' ? 'ready' : 'held',
      );
      assert.equal(issueProgression(issue, { mode: 'plan', now: 20 }).status, 'held');
    }
  });

  it('should require an actionable plan even with an operator transition', () => {
    for (const outcome of ['clarification-needed', 'operator-setup-blocker'])
      for (const mode of ['plan', 'work', 'auto'] as const)
        assert.deepEqual(
          issueProgression(
            { ...planning, result: { outcome } },
            {
              mode,
              now: 20,
              operator: true,
            },
          ),
          { status: 'held', reason: 'assessment-not-actionable' },
        );
    assert.deepEqual(issueProgression(planning, { mode: 'plan', now: 20, operator: true }), {
      status: 'ready',
      progression: { stage: 'implementation', via: 'operator', enteredAt: 20 },
    });
  });

  it('should preserve the first transition across mode changes and repeated evaluation', () => {
    const transition = issueProgression(planning, { mode: 'work', now: 20 });
    assert.equal(transition.status, 'ready');
    if (transition.status !== 'ready') throw new Error('transition missing');
    const issue = { ...planning, progression: transition.progression };
    for (const mode of ['plan', 'auto', 'work'] as const)
      assert.deepEqual(issueProgression(issue, { mode, now: 99, operator: true }), transition);
  });

  it('should recover legacy execution without promoting waiting or publication-only records', () => {
    for (const execution of [
      { continuation: { attempt: { id: 'request' }, phase: 'prepared' } },
      { continuation: { binding: { turnId: 'native' }, phase: 'running' } },
      { continuation: { result: { outcome: 'done' }, phase: 'delivery' } },
      { work: { implementation: { runId: 'owner', inputEventId: 'event' } } },
    ]) {
      const issue = { ...planning, ...execution };
      assert.deepEqual(retainedIssueProgression(issue), { stage: 'implementation', via: 'legacy' });
      assert.equal(issueProgression(issue, { mode: 'plan', now: 99 }).status, 'ready');
    }
    for (const issue of [
      planning,
      { ...planning, continuation: { phase: 'waiting' } },
      { ...planning, work: {} },
    ])
      assert.equal(retainedIssueProgression(issue), undefined);
  });

  it('should keep cancellation and inactive lifecycle separate from retained implementation', () => {
    const progression = { stage: 'implementation' as const, via: 'work' as const, enteredAt: 20 };
    for (const stop of [
      { retired: { at: 30 } },
      { retirement: { reason: 'unassigned' } },
      { reset: { at: 30 } },
      { continuation: { phase: 'cancelled' } },
    ])
      assert.equal(
        issueProgression(
          { ...planning, progression, ...stop },
          {
            mode: 'work',
            now: 99,
            operator: true,
          },
        ).status,
        'stopped',
      );
  });
});
