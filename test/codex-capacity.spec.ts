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
    reservationVersion: 1,
    createdAt: 0,
    manifestDigest: 'digest',
    request: {} as DispatchRecord['request'],
    feedback: { baseline: {}, events: events.map((phase) => ({ phase }) as FeedbackEvent) },
  }) as DispatchRecord;
describe('agent/codex-capacity', () => {
  it('should distinguish idle unfinished work from an active handed-off task', () => {
    const item = record('complete');
    item.continuation = { phase: 'running' } as DispatchRecord['continuation'];
    item.handoff = { at: 1, by: 'operator', turnId: 'work' };
    item.nativeInactive = true;
    assert.equal(codexCapacity([item], 1).occupied, 0);
    delete item.nativeInactive;
    item.capacityObservation = { at: 2, code: 'dispatch-capacity-native-active' };
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.continuation!.phase = 'complete';
    assert.equal(codexCapacity([item], 1).occupied, 1);
  });

  it('should release an unsubmitted initial continuation once feedback owns implementation', () => {
    const item = record('complete', ['published']);
    item.continuation = { phase: 'waiting' } as DispatchRecord['continuation'];
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.feedback!.events[0]!.work = { selection: {} as never };
    item.progression = { stage: 'implementation', via: 'work', workOwner: 'feedback' };
    assert.equal(codexCapacity([item], 1).occupied, 0);
    item.feedback!.events[0]!.phase = 'running';
    assert.equal(codexCapacity([item], 1).occupied, 1);
  });
  it('should require native inactivity before releasing blocked or retired creations', () => {
    const item = record('blocked');
    item.effective = { status: 'verified' };
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.retired = { at: 1, by: 'operator' };
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.nativeInactive = true;
    assert.equal(codexCapacity([item], 1).occupied, 0);
    item.feedback!.events.push({ phase: 'running' } as FeedbackEvent);
    assert.equal(codexCapacity([item], 1).occupied, 0);
    delete item.nativeInactive;
    assert.equal(codexCapacity([item], 1).occupied, 1);
  });
  it('should retain uncertain execution after cancellation or feedback authority loss', () => {
    const item = record('complete');
    item.continuation = { phase: 'cancelled', attempt: {} } as DispatchRecord['continuation'];
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.nativeInactive = true;
    assert.equal(codexCapacity([item], 1).occupied, 0);
    delete item.continuation;
    item.nativeInactive = false;
    item.feedback!.events.push({ phase: 'blocked', attempt: {} } as FeedbackEvent);
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.nativeInactive = true;
    assert.equal(codexCapacity([item], 1).occupied, 0);
  });
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
  it('should reserve unfinished delivery from its result despite an obsolete complete phase', () => {
    const item = record('complete');
    item.continuation = {
      phase: 'complete',
      result: { outcome: 'done' },
    } as DispatchRecord['continuation'];
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.continuation!.head = 'new';
    item.delivery = {
      reconciled: true,
      pushedHead: 'old',
      pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
    } as DispatchRecord['delivery'];
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.delivery!.pushedHead = 'new';
    assert.equal(codexCapacity([item], 1).occupied, 0);
  });
  it('should release reconciled pr delivery without releasing active feedback or implementation', () => {
    const item = record('complete');
    item.continuation = { phase: 'delivery' } as DispatchRecord['continuation'];
    item.delivery = {
      reconciled: false,
      pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
    } as DispatchRecord['delivery'];
    assert.deepEqual(codexCapacity([item], 3), { occupied: 1, available: 2 });
    item.delivery!.reconciled = true;
    assert.deepEqual(codexCapacity([item], 3), { occupied: 0, available: 3 });
    item.feedback!.events.push({ phase: 'running' } as FeedbackEvent);
    assert.deepEqual(codexCapacity([item], 3), { occupied: 1, available: 2 });
    item.feedback!.events = [];
    item.continuation!.phase = 'running';
    assert.deepEqual(codexCapacity([item], 3), { occupied: 1, available: 2 });
  });
});
