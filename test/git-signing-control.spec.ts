import assert from 'node:assert/strict';

import gitCommandHasSigningControl from '../tools/git/signing-control.ts';

describe('tools/git/signing-control', () => {
  it('should detect signing controls only where git assigns signing semantics', () => {
    for (const argv of [
      ['commit', '--no-gpg-sign'],
      ['merge', '-Skey', 'topic'],
      ['rebase', '--gpg-sign=key', 'main'],
      ['tag', '--no-sign', 'v1.0.0'],
      ['tag', '--local-user=key', 'v1.0.0'],
      ['tag', '-s', 'v1.0.0'],
    ]) {
      assert.equal(gitCommandHasSigningControl({ argv }), true, argv.join(' '));
    }
    assert.equal(gitCommandHasSigningControl({ argv: ['log', '-Sneedle'] }), false);
    assert.equal(gitCommandHasSigningControl({ argv: ['status', '--short'] }), false);
  });
});
