import assert from 'node:assert/strict';

import DiscoveryBudget, { DiscoveryPaused } from '../agent/discovery-budget.ts';

describe('agent/discovery-budget', () => {
  it('should abandon a cancelled read even when its provider ignores cancellation', async () => {
    const caller = new AbortController();
    const budget = new DiscoveryBudget(20000, caller.signal);
    const deferred = Promise.withResolvers<string>();
    const read = budget.read('provider-connection', () => deferred.promise);
    await Promise.resolve();
    caller.abort();
    deferred.resolve('late result');
    await assert.rejects(read, DiscoveryPaused);
    assert.equal(budget.operation, 'provider-connection');
  });

  it('should retain the innermost operation across phase budgets', async () => {
    const budget = new DiscoveryBudget();
    await budget.fork(7000).read('automation-readiness', async () => 'ready');
    assert.equal(budget.operation, 'automation-readiness');
  });

  it('should reserve time for sibling phases without extending the occurrence', () => {
    let clock = 0;
    const occurrence = new DiscoveryBudget(20_000, undefined, () => clock);
    clock = 7000;
    const lifecycle = occurrence.fork(occurrence.remaining / 2);
    clock = lifecycle.deadline;
    assert.throws(() => lifecycle.check(), DiscoveryPaused);
    assert.doesNotThrow(() => occurrence.check());
    assert.equal(occurrence.remaining, 6500);
    assert.equal(occurrence.deadline, 20_000);
    assert.equal(occurrence.fork(20_000).deadline, occurrence.deadline);
  });

  it('should propagate caller cancellation to every phase', () => {
    const caller = new AbortController();
    const occurrence = new DiscoveryBudget(20_000, caller.signal);
    const phase = occurrence.fork(7000);
    caller.abort();
    assert.throws(() => occurrence.check(), DiscoveryPaused);
    assert.throws(() => phase.check(), DiscoveryPaused);
  });

  it('should not revive an exhausted occurrence or use fractional timer durations', () => {
    let clock = 0;
    const occurrence = new DiscoveryBudget(20_000, undefined, () => clock);
    assert.equal(occurrence.fork(1000.5).deadline, 1000);
    clock = 21_000;
    assert.equal(occurrence.remaining, 0);
    assert.throws(() => occurrence.fork(7000).check(), DiscoveryPaused);
  });
});
