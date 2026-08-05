import assert from 'node:assert/strict';

import resolveAgentEnvironment from '../utils/resolve-agent-environment.ts';

describe('utils/resolve-agent-environment', () => {
  it('should separate sorted metadata from literal values', () => {
    const resolved = resolveAgentEnvironment({
      schemaVersion: 1,
      agent: { id: 'data' },
      environment: {
        set: { ZEBRA: 'last-value', GITHUB_TOKEN: 'protected-value', ALPHA: 'first-value' },
      },
    });

    assert.deepEqual(resolved.values, {
      ZEBRA: 'last-value',
      GITHUB_TOKEN: 'protected-value',
      ALPHA: 'first-value',
    });
    assert.deepEqual(resolved.variables, [
      { name: 'ALPHA', source: 'environment.set', staticExecDelivery: 'exec-candidate' },
      {
        name: 'GITHUB_TOKEN',
        source: 'environment.set',
        staticExecDelivery: 'documented-filtered',
      },
      { name: 'ZEBRA', source: 'environment.set', staticExecDelivery: 'exec-candidate' },
    ]);
  });

  it('should resolve a manifest without environment data to empty collections', () => {
    assert.deepEqual(resolveAgentEnvironment({ schemaVersion: 1, agent: { id: 'data' } }), {
      values: {},
      variables: [],
    });
  });
});
