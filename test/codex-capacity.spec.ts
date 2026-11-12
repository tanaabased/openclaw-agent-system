import assert from 'node:assert/strict';
import codexCapacity from '../agent/tasks/dispatch/codex-capacity.ts';
import type { DispatchRecord } from '../agent/tasks/dispatch/codex-dispatch-state.ts';

const record = () => ({ id: 'issue', request: {} }) as DispatchRecord;

describe('agent/codex-capacity', () => {
  it('should reserve unknown native custody and release only observed inactivity', () => {
    const item = record();
    assert.equal(codexCapacity([item], 1).occupied, 1);
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
