import assert from 'node:assert/strict';

import {
  gitCommandHasSigningControl,
  gitCommandUsesSigningResources,
} from '../tools/git/signing-command.ts';

describe('tools/git/signing-command', () => {
  it('should select supported commit and tag creation operations', () => {
    for (const argv of [
      ['am', 'patch.mbox'],
      ['cherry-pick', 'HEAD~1'],
      ['commit', '--message', 'change'],
      ['merge', 'topic'],
      ['pull', 'origin', 'main'],
      ['rebase', 'main'],
      ['revert', 'HEAD'],
      ['tag', 'v1.0.0'],
    ]) {
      assert.equal(gitCommandUsesSigningResources({ argv }), true, argv.join(' '));
    }
  });

  it('should skip reads and operations that cannot create a signed object', () => {
    for (const argv of [
      ['commit', '--dry-run'],
      ['merge', '--ff-only', 'topic'],
      ['rebase', '--abort'],
      ['cherry-pick', '--no-commit', 'HEAD~1'],
      ['status'],
      ['tag'],
      ['tag', '--delete', 'v1.0.0'],
      ['tag', '--list'],
      ['tag', '--verify', 'v1.0.0'],
      ['verify-commit', 'HEAD'],
    ]) {
      assert.equal(gitCommandUsesSigningResources({ argv }), false, argv.join(' '));
    }
  });

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
