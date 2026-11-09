import assert from 'node:assert/strict';
import implementationHandoff from '../agent/implementation-handoff.ts';

describe('agent/implementation-handoff', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should route completed ${runtime} work into its native delivery owner`, () => {
      const handoff = implementationHandoff('done', runtime);
      assert.equal(handoff.next, 'delivery');
      assert.deepEqual(
        handoff.request,
        runtime === 'codex'
          ? { action: 'delivery', delivery: { action: 'publish' } }
          : { action: 'delivery', operation: 'publish' },
      );
    });
    it(`should leave unfinished ${runtime} work out of publication`, () => {
      for (const outcome of ['blocked', 'clarification-needed', undefined] as const) {
        const handoff = implementationHandoff(outcome, runtime);
        assert.equal(handoff.next, outcome === 'blocked' ? 'blocked' : 'implementation');
        assert.equal(handoff.request, undefined);
      }
    });
  }
});
