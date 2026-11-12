import assert from 'node:assert/strict';

import issueProgression, { retainedIssueProgression } from '../agent/tasks/issue-progression.ts';

const planning = {};

describe('agent/issue-progression', () => {
  it('should use live mode only to select the planning-to-implementation transition', () => {
    assert.deepEqual(issueProgression(planning, { mode: 'plan' }), {
      status: 'held',
      reason: 'implementation-disabled',
    });
    assert.deepEqual(issueProgression(planning, { mode: 'work' }), {
      status: 'ready',
      progression: { stage: 'implementation', via: 'work' },
    });
    assert.deepEqual(issueProgression(planning, { mode: 'auto' }), {
      status: 'held',
      reason: 'auto-decision-required',
    });
  });

  it('should permit work without a saved assessment', () => {
    const issue = {};
    assert.equal(issueProgression(issue, { mode: 'work' }).status, 'ready');
    assert.equal(issueProgression(issue, { mode: 'plan' }).status, 'held');
    assert.equal(issueProgression(issue, { mode: 'plan', operator: true }).status, 'ready');
  });

  it('should accept a bounded auto decision without serializing a plan', () => {
    assert.equal(issueProgression({}, { mode: 'auto' }).status, 'held');
    assert.equal(
      issueProgression(
        {},
        { mode: 'auto', decision: { mode: 'plan', reasons: ['Need an answer.'] } },
      ).status,
      'held',
    );
    assert.equal(
      issueProgression(
        {},
        { mode: 'auto', decision: { mode: 'work', reasons: ['Scope is clear.'] } },
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
        issueProgression(issue, { mode: 'auto' }).status,
        mode === 'work' ? 'ready' : 'held',
      );
    }
  });

  it('should preserve the first transition across mode changes and repeated evaluation', () => {
    const transition = issueProgression(planning, { mode: 'work' });
    assert.equal(transition.status, 'ready');
    if (transition.status !== 'ready') throw new Error('transition missing');
    const issue = { ...planning, progression: transition.progression };
    for (const mode of ['plan', 'auto', 'work'] as const)
      assert.deepEqual(issueProgression(issue, { mode, operator: true }), transition);
  });

  it('should require an explicit stage instead of inferring it from execution receipts', () => {
    const execution = {
      progression: undefined,
      work: { implementation: { runId: 'owner', inputEventId: 'event' } },
    };
    assert.equal(retainedIssueProgression(execution), undefined);
    assert.equal(issueProgression(execution, { mode: 'plan' }).status, 'held');
    for (const issue of [
      planning,
      { ...planning, nativeWork: { cancelled: true as const } },
      { ...planning, work: {} },
    ])
      assert.equal(retainedIssueProgression(issue), undefined);
  });

  it('should keep cancellation and inactive lifecycle separate from retained implementation', () => {
    const progression = { stage: 'implementation' as const, via: 'work' as const };
    assert.equal(
      issueProgression(
        { ...planning, progression, handoff: {}, nativeWork: { cancelled: true as const } },
        { mode: 'plan' },
      ).status,
      'ready',
    );
    for (const stop of [{ reset: { at: 30 } }, { retirement: { reason: 'unassigned' } }])
      assert.equal(
        issueProgression(
          { ...planning, progression, ...stop },
          {
            mode: 'work',
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
    assert.equal(issueProgression(issue, { mode: 'work' }).status, 'stopped');
    assert.equal(issueProgression(issue, { mode: 'plan', operator: true }).status, 'ready');
  });
});
