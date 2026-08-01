import assert from 'node:assert/strict';

import encode from '../utils/encode.ts';

describe('utils/encode', () => {
  it('should preserve nullish values', () => {
    assert.equal(encode(null), null);
    assert.equal(encode(undefined), undefined);
  });

  it('should encode each segment of a dotted name', () => {
    assert.equal(encode('agent.git.githubUsername'), 'agent.git.github-username');
  });

  it('should encode arrays of dotted names', () => {
    assert.deepEqual(encode(['schemaVersion', 'agent.githubUsername']), [
      'schema-version',
      'agent.github-username',
    ]);
  });

  it('should deeply encode plain-object keys without mutating the input', () => {
    const input = {
      schemaVersion: 1,
      agent: {
        githubUsername: 'emoriwan',
      },
    };

    assert.deepEqual(encode(input), {
      'schema-version': 1,
      agent: {
        'github-username': 'emoriwan',
      },
    });
    assert.deepEqual(input, {
      schemaVersion: 1,
      agent: {
        githubUsername: 'emoriwan',
      },
    });
  });

  it('should preserve scoped package keys', () => {
    assert.deepEqual(encode({ '@tanaab/openclaw-agent-system': true }), {
      '@tanaab/openclaw-agent-system': true,
    });
  });
});
