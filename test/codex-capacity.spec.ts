import assert from 'node:assert/strict';

import codexCapacity from '../agent/codex-capacity.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { FeedbackEvent } from '../agent/codex-feedback-state.ts';

const record = (phase: DispatchRecord['phase'], events: FeedbackEvent['phase'][] = []) =>
  ({
    id: 'record',
    intakeId: 'intake',
    issueKey: 'issue',
    sourceThreadId: 'source',
    phase,
    createdAt: 0,
    manifestDigest: 'digest',
    request: {} as DispatchRecord['request'],
    feedback: { baseline: {}, events: events.map((phase) => ({ phase }) as FeedbackEvent) },
  }) as DispatchRecord;
describe('agent/codex-capacity', () => {
  it('should count feedback and assignments in one pool without double-counting a busy owner', () => {
    const active = [
      record('assessing', ['queued', 'queued']),
      record('complete', ['running', 'queued']),
      record('complete', ['running']),
      record('complete', ['queued']),
    ];
    assert.deepEqual(codexCapacity(active, 3), { occupied: 3, available: 0 });
    active[0]!.phase = 'complete';
    assert.deepEqual(codexCapacity(active, 3), { occupied: 2, available: 1 });
    active[3]!.feedback!.events[0]!.phase = 'prepared';
    assert.deepEqual(codexCapacity(active, 3), { occupied: 3, available: 0 });
  });
  it('should release finished or blocked feedback and not reserve slots for queued comments', () => {
    assert.deepEqual(codexCapacity([record('complete', ['queued', 'blocked', 'published'])], 3), {
      occupied: 0,
      available: 3,
    });
    assert.throws(() => codexCapacity([], 0), /capacity-invalid/);
  });
});
