import assert from 'node:assert/strict';

import decode from '../utils/decode.ts';

describe('utils/decode', () => {
  it('should preserve nullish values', () => {
    assert.equal(decode(null), null);
    assert.equal(decode(undefined), undefined);
  });

  it('should decode each segment of a dotted name', () => {
    assert.equal(decode('agent.git.github-username'), 'agent.git.githubUsername');
  });

  it('should decode arrays of dotted names', () => {
    assert.deepEqual(decode(['schema-version', 'agent.github-username']), [
      'schemaVersion',
      'agent.githubUsername',
    ]);
  });

  it('should deeply decode object keys without mutating the input', () => {
    const input = {
      'schema-version': 1,
      agent: {
        'github-username': 'emoriwan',
      },
    };

    assert.deepEqual(decode(input), {
      schemaVersion: 1,
      agent: {
        githubUsername: 'emoriwan',
      },
    });
    assert.deepEqual(input, {
      'schema-version': 1,
      agent: {
        'github-username': 'emoriwan',
      },
    });
  });
});
