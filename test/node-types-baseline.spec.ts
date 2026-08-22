import assert from 'node:assert/strict';

import nodeTypesBaselineFailure from '../scripts/node-types-baseline.ts';

describe('scripts/node-types-baseline', () => {
  it('should accept node types that target the runtime major', () => {
    assert.equal(nodeTypesBaselineFailure('26.7.0', '^26.0.0'), undefined);
  });

  it('should reject node types that target another runtime major', () => {
    assert.equal(
      nodeTypesBaselineFailure('26.7.0', '^24.0.0'),
      'package.json devDependencies.@types/node must target Node 26',
    );
  });

  it('should reject a missing or ambiguous node types range', () => {
    assert.equal(
      nodeTypesBaselineFailure('26.7.0', undefined),
      'package.json devDependencies.@types/node must target Node 26',
    );
    assert.equal(
      nodeTypesBaselineFailure('26.7.0', '>=26 <27'),
      'package.json devDependencies.@types/node must target Node 26',
    );
  });
});
