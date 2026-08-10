import assert from 'node:assert/strict';

import gitCommandUsesSshResources from '../tools/git/ssh-command.ts';

describe('tools/git/ssh-command', () => {
  it('should acquire ssh resources for remote-capable git commands', () => {
    for (const argv of [
      ['clone', 'git@github.com:owner/repository.git'],
      ['fetch', 'origin'],
      ['ls-remote', 'git@github.com:owner/repository.git'],
      ['pull'],
      ['push', 'origin', 'main'],
      ['remote', 'show', 'origin'],
      ['submodule', 'update', '--init'],
    ]) {
      assert.equal(gitCommandUsesSshResources({ argv }), true);
    }
  });

  it('should skip ssh resources for local-only git commands', () => {
    for (const argv of [
      ['commit', '--message', 'local'],
      ['log', '-1'],
      ['remote', 'get-url', 'origin'],
      ['status', '--short'],
    ]) {
      assert.equal(gitCommandUsesSshResources({ argv }), false);
    }
  });
});
