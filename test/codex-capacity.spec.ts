import assert from 'node:assert/strict';
import codexCapacity from '../agent/codex-capacity.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';

const record = () => ({ id: 'issue', request: {}, phase: 'complete' }) as DispatchRecord;

describe('agent/codex-capacity', () => {
  it('should reserve unknown native custody and release only observed inactivity', () => {
    const item = record();
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.nativeInactive = true;
    assert.equal(codexCapacity([item], 1).occupied, 0);
    item.nativeInactive = false;
    assert.equal(codexCapacity([item], 1).occupied, 1);
  });

  for (const phase of [
    'waiting',
    'running',
    'clarification-needed',
    'blocked',
    'cancelled',
    'complete',
  ] as const)
    it(`should ignore ${phase} bookkeeping when native activity is known`, () => {
      const item = record();
      item.continuation = { phase } as DispatchRecord['continuation'];
      item.nativeInactive = true;
      assert.equal(codexCapacity([item], 1).occupied, 0);
      item.nativeInactive = false;
      assert.equal(codexCapacity([item], 1).occupied, 1);
    });

  it('should count a busy conversation once regardless of its queued comments or pr receipts', () => {
    const item = record();
    item.feedback = {
      baseline: {},
      events: [{ phase: 'queued' }, { phase: 'running' }],
    } as DispatchRecord['feedback'];
    item.delivery = {
      reconciled: true,
      pullRequest: { pullRequestNodeId: 'pr', pullRequestNumber: 7 },
    } as DispatchRecord['delivery'];
    assert.deepEqual(codexCapacity([item], 3), { occupied: 1, available: 2 });
    item.nativeInactive = true;
    assert.deepEqual(codexCapacity([item], 3), { occupied: 0, available: 3 });
  });

  it('should retain uncertain retirement custody and exclude replaced or unsubmitted owners', () => {
    const item = record();
    item.retired = { at: 1, by: 'operator' };
    assert.equal(codexCapacity([item], 1).occupied, 1);
    item.nativeInactive = true;
    assert.equal(codexCapacity([item], 1).occupied, 0);
    delete item.nativeInactive;
    item.supersededBy = 'successor';
    assert.equal(codexCapacity([item], 1).occupied, 0);
    delete item.supersededBy;
    delete item.request;
    assert.equal(codexCapacity([item], 1).occupied, 0);
    assert.throws(() => codexCapacity([], 0), /capacity-invalid/);
  });
});
