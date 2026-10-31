import assert from 'node:assert/strict';
import implementationHandoff from '../agent/implementation-handoff.ts';

describe('agent/implementation-handoff', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should route completed ${runtime} work into its native delivery owner`, () => {
      const handoff = implementationHandoff('issue', 'done', runtime);
      assert.equal(handoff.next, 'delivery');
      assert.deepEqual(
        handoff.request,
        runtime === 'codex'
          ? { action: 'delivery', id: 'issue', delivery: { action: 'prepare' } }
          : { action: 'delivery', id: 'issue', operation: 'prepare' },
      );
    });
    it(`should leave unfinished ${runtime} work out of publication`, () => {
      for (const outcome of ['blocked', 'clarification-needed', undefined] as const) {
        const handoff = implementationHandoff('issue', outcome, runtime);
        assert.equal(handoff.next, outcome ?? 'implementation');
        assert.equal(handoff.request, undefined);
        assert.ok(handoff.instruction);
        if (outcome === undefined) {
          assert.match(handoff.instruction, /prerequisites/);
          assert.match(handoff.instruction, /post-merge verification/);
        } else {
          assert.match(handoff.instruction, /unfinished/);
          assert.match(handoff.instruction, /Do not request completed-work PR delivery/);
          assert.match(handoff.instruction, /resume/);
          if (outcome === 'clarification-needed')
            assert.match(handoff.instruction, /wait for an answer/);
        }
      }
    });
  }
});
