import assert from 'node:assert/strict';

import issueProgression, { retainedIssueProgression } from '../agent/issue-progression.ts';

const planning = { createdAt: 10 };

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
  });

  it('should permit work without a saved assessment', () => {
    {
      const issue = {};
      assert.equal(issueProgression(issue, { mode: 'work', now: 20 }).status, 'ready');
      assert.equal(issueProgression(issue, { mode: 'plan', now: 20 }).status, 'held');
      assert.equal(
        issueProgression(issue, { mode: 'plan', now: 20, operator: true }).status,
        'ready',
      );
    }
  });

  it('should accept a bounded auto decision without serializing a plan', () => {
    assert.equal(issueProgression({}, { mode: 'auto', now: 20 }).status, 'held');
    assert.equal(
      issueProgression(
        {},
        { mode: 'auto', now: 20, decision: { mode: 'plan', reasons: ['Need an answer.'] } },
      ).status,
      'held',
    );
    assert.equal(
      issueProgression(
        {},
        { mode: 'auto', now: 20, decision: { mode: 'work', reasons: ['Scope is clear.'] } },
      ).status,
      'ready',
    );
  });

  it('should retain the explicit native auto decision', () => {
    for (const mode of ['plan', 'work'] as const) {
      const issue = {
        implementationDecision: { mode, reasons: ['Current native decision.'] },
      };
      assert.equal(
        issueProgression(issue, { mode: 'auto', now: 20 }).status,
        mode === 'work' ? 'ready' : 'held',
      );
    }
  });

  it('should preserve the first transition across mode changes and repeated evaluation', () => {
    const transition = issueProgression(planning, { mode: 'work', now: 20 });
    assert.equal(transition.status, 'ready');
    if (transition.status !== 'ready') throw new Error('transition missing');
    const issue = { ...planning, progression: transition.progression };
    for (const mode of ['plan', 'auto', 'work'] as const)
      assert.deepEqual(issueProgression(issue, { mode, now: 99, operator: true }), transition);
  });

  it('should require an explicit stage instead of inferring it from execution receipts', () => {
    for (const execution of [
      { work: { implementation: { runId: 'owner', inputEventId: 'event' } } },
    ]) {
      const issue = { ...planning, ...execution };
      assert.equal(retainedIssueProgression(issue), undefined);
      assert.equal(issueProgression(issue, { mode: 'plan', now: 99 }).status, 'held');
    }
    for (const issue of [
      planning,
      { ...planning, nativeWork: { cancelled: true as const } },
      { ...planning, work: {} },
    ])
      assert.equal(retainedIssueProgression(issue), undefined);
  });

  it('should keep cancellation and inactive lifecycle separate from retained implementation', () => {
    const progression = { stage: 'implementation' as const, via: 'work' as const, enteredAt: 20 };
    assert.equal(
      issueProgression(
        { ...planning, progression, handoff: {}, nativeWork: { cancelled: true as const } },
        { mode: 'plan', now: 99 },
      ).status,
      'ready',
    );
    for (const stop of [
      { reset: { at: 30 } },
      { retirement: { reason: 'unassigned' } },
      { reset: { at: 30 } },
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
  it('should preserve cancellation until new explicit direction arrives', () => {
    const issue = {
      nativeWork: { cancelled: true as const },
    };
    assert.equal(issueProgression(issue, { mode: 'work', now: 99 }).status, 'stopped');
    assert.equal(
      issueProgression(issue, { mode: 'plan', now: 99, operator: true }).status,
      'ready',
    );
  });
});
