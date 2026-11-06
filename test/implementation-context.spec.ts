import assert from 'node:assert/strict';
import implementationContext from '../agent/implementation-context.ts';

describe('agent/implementation-context', () => {
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should use native context and retain explicit publication scope for ${runtime}`, () => {
      const context = implementationContext({
        runtime,
        id: 'issue',
        path: '/checkout',
        direct: true,
        scope: 'local',
      });
      assert.equal(context.publicationAuthorized, false);
      assert.equal(context.recording, 'optional-history');
      assert.equal('plan' in context, false);
      assert.equal('assessment' in context, false);
      assert.equal('previousResult' in context, false);
      assert.equal('deliveryOnly' in context, false);
      assert.equal(context.handoff.next, 'implementation');
      assert.equal(
        implementationContext({ runtime, id: 'issue', path: '/checkout', scope: 'pull-request' })
          .publicationAuthorized,
        true,
      );
    });
});
