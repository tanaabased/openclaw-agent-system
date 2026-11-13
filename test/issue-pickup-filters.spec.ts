import assert from 'node:assert/strict';

import issuePickupFilters from '../agent/issue-pickup-filters.ts';
import fixture from './issue-pickup-selection-fixture.ts';

describe('agent/issue-pickup-filters', () => {
  it('should match any native type without inferring types from labels or prose', () => {
    const candidate = { issueType: { name: 'Customer Request' }, labels: ['bug'] };
    assert.equal(issuePickupFilters(candidate, { types: ['Bug', 'CUSTOMER REQUEST'] }), true);
    assert.equal(issuePickupFilters(candidate, { types: ['Bug'] }), false);
    assert.equal(
      issuePickupFilters({ labels: ['bug'], issueType: null }, { types: ['Bug'] }),
      false,
    );
    assert.equal(issuePickupFilters(candidate, { types: ['Customer*'] }), false);
    assert.equal(issuePickupFilters({ labels: [] }), true);
    assert.equal(issuePickupFilters({ labels: [] }, { types: [] }), true);
    assert.throws(
      () => issuePickupFilters({ labels: ['bug'] }, { types: ['Bug'] }),
      /issue-pickup-type-unavailable/,
    );
  });

  it('should require the type and all positive labels while preserving exclusion precedence', () => {
    const filters = { types: ['Bug'], labels: ['ready*', 'priority:*', '!blocked'] };
    const candidate = { issueType: { name: 'BUG' }, labels: ['ready now', 'priority: high'] };
    assert.equal(issuePickupFilters(candidate, filters), true);
    assert.equal(issuePickupFilters({ ...candidate, labels: ['ready now'] }, filters), false);
    assert.equal(
      issuePickupFilters({ ...candidate, labels: [...candidate.labels, 'BLOCKED'] }, filters),
      false,
    );
    assert.equal(issuePickupFilters({ ...candidate, issueType: { name: 'Task' } }, filters), false);
  });

  it('should filter discovery before dependency reads and expose unavailable type evidence', async () => {
    const f = fixture();
    f.policy.issuePickup!.projects[0]!.filters = { types: ['Bug'] };
    const candidate = f.candidates.get(f.item.number)!;
    candidate.issueType = null;
    candidate.title = 'Bug';
    candidate.body = 'type: Bug';
    candidate.labels = ['bug'];
    f.client.projectBlocked = async () => {
      throw new Error('nonmatch reached dependency read');
    };
    assert.equal((await f.run()).status, 'empty');
    delete candidate.issueType;
    const other = { ...f.item, number: f.item.number + 1, nodeId: 'I_readable' };
    f.items.set(other.number, other);
    f.candidates.set(other.number, {
      ...candidate,
      number: other.number,
      nodeId: other.nodeId,
      issueType: { name: 'Bug' },
    });
    f.client.projectBlocked = async () => false;
    f.tx.runId = 'missing-evidence';
    const result = await f.run();
    assert.equal(result.status, 'selection-required');
    assert.ok('candidates' in result && result.candidates);
    assert.deepEqual(
      result.candidates.map((entry) => entry.nodeId),
      [other.nodeId],
    );
    assert.equal(
      f.state.projectPickup!.operations[0]!.deferred?.[0]?.code,
      'issue-pickup-type-unavailable',
    );
    assert.equal(f.effects.writes, 0);
  });

  for (const change of ['matching', 'different', 'none', 'unavailable'] as const) {
    it(`should recheck native type before assignment when ${change}`, async () => {
      const f = fixture();
      f.policy.issuePickup!.projects[0]!.filters = { types: ['Bug', 'Customer Request'] };
      const candidate = f.candidates.get(f.item.number)!;
      candidate.issueType = { name: 'Bug' };
      const selection = await f.select();
      if (change === 'unavailable') delete candidate.issueType;
      else
        candidate.issueType =
          change === 'none' ? null : { name: change === 'matching' ? 'customer request' : 'Task' };
      const result = await f.run({ selection });
      assert.equal(result.status, change === 'matching' ? 'assigned' : 'failed');
      assert.equal(f.effects.writes, change === 'matching' ? 1 : 0);
      if (change !== 'matching')
        assert.equal(
          result.code,
          change === 'unavailable'
            ? 'issue-pickup-type-unavailable'
            : 'issue-pickup-candidate-ineligible',
        );
    });
  }
});
