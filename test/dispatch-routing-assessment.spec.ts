import assert from 'node:assert/strict';

import dispatchRoutingAssessment from '../agent/dispatch-routing-assessment.ts';

const assessment = {
  complexity: 'high',
  reason: 'Substantial architectural uncertainty.',
  xhighReason: 'Several coupled invariants require extended reasoning.',
};

describe('agent/dispatch-routing-assessment', () => {
  for (const source of ['native', 'body fallback'] as const) {
    it(`should honor verified ${source} complexity without retaining a contradictory reason`, () => {
      const result = dispatchRoutingAssessment(assessment, {
        status: 'verified',
        value: 'medium',
        source,
      });
      assert.deepEqual(result, {
        ...assessment,
        complexity: 'medium',
        reason: `Verified ${source} Complexity: medium.`,
      });
      assert.equal(assessment.complexity, 'high');
    });
  }

  it('should preserve content assessment without verified complexity', () => {
    assert.equal(dispatchRoutingAssessment(assessment), assessment);
    for (const status of ['missing', 'invalid', 'conflicting', 'unavailable'] as const)
      assert.equal(dispatchRoutingAssessment(assessment, { status, source: 'native' }), assessment);
  });

  it('should leave malformed assessments for the routing validator to reject', () => {
    const invalid = { complexity: 'high', reason: '' };
    assert.equal(
      dispatchRoutingAssessment(invalid, {
        status: 'verified',
        value: 'medium',
        source: 'native',
      }),
      invalid,
    );
  });
});
