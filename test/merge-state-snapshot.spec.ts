import assert from 'node:assert/strict';

import mergeStateSnapshot, { refreshStateSnapshot } from '../core/merge-state-snapshot.ts';

describe('core/merge-state-snapshot', () => {
  it('should preserve independent record and event updates with retained object references', () => {
    const before = { records: [{ id: 'a', events: [{ id: 'event', status: 'attempted' }] }] };
    const desired = structuredClone(before);
    desired.records[0]!.events[0]!.status = 'accepted';
    const current = structuredClone(before);
    Object.assign(current.records[0]!, { result: 'plan' });
    current.records.push({ id: 'b', events: [] });
    const record = desired.records[0]!;
    const event = record.events[0]!;
    const merged = mergeStateSnapshot(before, desired, current);
    refreshStateSnapshot(desired, merged as typeof before);
    assert.equal(desired.records[0], record);
    assert.equal(record.events[0], event);
    assert.equal(event.status, 'accepted');
    assert.deepEqual(desired.records[0], {
      id: 'a',
      result: 'plan',
      events: [{ id: 'event', status: 'accepted' }],
    });
    assert.equal(desired.records[1]!.id, 'b');
  });

  it('should reject competing reservations even when their values are identical', () => {
    for (const [before, after] of [
      [{}, { attempted: true }],
      [{ attempted: false }, { attempted: true }],
      [{ records: [] }, { records: [{ id: 'a', attempted: true }] }],
      [
        { records: [{ id: 'a' }] },
        { records: [{ id: 'a', turn: { runId: 'one', status: 'attempted' } }] },
      ],
    ])
      assert.throws(
        () => mergeStateSnapshot(before, after, after),
        /private-state-snapshot-conflict/,
      );
  });

  it('should reject conflicting edits and deletion of concurrently changed state', () => {
    assert.throws(
      () => mergeStateSnapshot({ result: 'old' }, { result: 'mine' }, { result: 'theirs' }),
      /private-state-snapshot-conflict/,
    );
    assert.throws(
      () =>
        mergeStateSnapshot(
          { records: [{ id: 'a', result: 'old' }] },
          { records: [] },
          { records: [{ id: 'a', result: 'new' }] },
        ),
      /private-state-snapshot-conflict/,
    );
    assert.deepEqual(
      mergeStateSnapshot({ records: [{ id: 'a' }] }, { records: [] }, { records: [{ id: 'a' }] }),
      { records: [] },
    );
  });
});
