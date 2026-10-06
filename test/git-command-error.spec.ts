import assert from 'node:assert/strict';

import GitCommandError from '../tools/git/command-error.ts';

describe('tools/git/command-error', () => {
  for (const [stderr, category] of [
    ['git@github.com: Permission denied (publickey).', 'ssh-authentication'],
    ['Host key verification failed.', 'ssh-host-key'],
    ['Could not resolve hostname github.com', 'dns'],
    ['Connection reset by peer', 'transport'],
    ['fatal: repository not found', 'repository-unavailable'],
    ['No space left on device', 'disk-full'],
    ['Permission denied', 'permission'],
    ['fatal: unable to create private.lock', 'lock'],
    ['private upstream failure', 'unknown'],
  ]) {
    it(`should classify ${category} without retaining upstream text`, () => {
      const error = new GitCommandError('clone', { exitCode: 128, stderr: stderr! });
      assert.equal(error.category, category);
      assert.equal(error.exitCode, 128);
      assert.equal(error.operation, 'clone');
      assert.equal(error.diagnosticCode, `git-clone-${category}-exit-128`);
      assert.equal(error.message.includes(stderr!), false);
      assert.equal(JSON.stringify(error).includes(stderr!), false);
    });
  }

  it('should bound operation names and retain abnormal termination', () => {
    const error = new GitCommandError('secret-token', { exitCode: null, stderr: 'secret-token' });
    assert.equal(error.diagnosticCode, 'git-unknown-unknown-exit-terminated');
    assert.equal(error.message.includes('secret-token'), false);
  });
});
