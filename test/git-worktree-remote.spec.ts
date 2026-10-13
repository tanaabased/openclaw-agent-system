import assert from 'node:assert/strict';

import normalizeGitWorktreeRemote, {
  githubSshWorktreeRemote,
  gitRemoteIdentity,
  preferGitHubSshWorktreeRemote,
} from '../tools/git/worktree-remote.ts';

describe('tools/git/worktree-remote', () => {
  it('should compare full remote identities across supported transports', () => {
    for (const remote of [
      'https://github.com/Owner/Repo.git',
      'git@github.com:owner/repo.git',
      'ssh://git@github.com/owner/repo.git',
    ]) {
      assert.equal(gitRemoteIdentity(remote), 'github.com/owner/repo');
    }
    assert.notEqual(
      gitRemoteIdentity('https://elsewhere.example/owner/repo.git'),
      'github.com/owner/repo',
    );
    assert.notEqual(
      gitRemoteIdentity('https://github.com/another/repo.git'),
      'github.com/owner/repo',
    );
    assert.equal(
      gitRemoteIdentity('https://github.com/Owner/.github.git'),
      'github.com/owner/.github',
    );
    assert.equal(gitRemoteIdentity('git@github.com:Owner/_repo.git'), 'github.com/owner/_repo');
    for (const remote of [
      'https://github.com/owner/repo%2fother',
      'ssh://git@github.com:2222/owner/repo.git',
    ])
      assert.throws(() => gitRemoteIdentity(remote));
  });
  it('should accept supported network remotes without a repository allowlist', () => {
    for (const remote of [
      'https://example.com/any/where.git',
      'ssh://git@example.com/any/where.git',
      'git://example.com/any/where.git',
      'git@example.com:any/where.git',
    ]) {
      assert.equal(normalizeGitWorktreeRemote(remote), remote);
    }
    assert.equal(
      normalizeGitWorktreeRemote('https://EXAMPLE.com:443/any/where.git'),
      'https://example.com/any/where.git',
    );
    assert.equal(
      normalizeGitWorktreeRemote('git@EXAMPLE.com:any/where.git'),
      'git@example.com:any/where.git',
    );
  });

  it('should reject local, credential-bearing, option-like, and shell-shaped remotes', () => {
    for (const remote of [
      '../repository',
      '/repository',
      'file:///repository',
      'https://user:secret@example.com/repository.git',
      'https://token@example.com/repository.git',
      'https://example.com/repository.git?token=secret',
      '--upload-pack=helper',
      'https://example.com/repository.git;touch bad',
    ]) {
      assert.throws(() => normalizeGitWorktreeRemote(remote), /clone source/u, remote);
    }
  });

  it('should derive ssh only from canonical github https remotes', () => {
    assert.equal(
      githubSshWorktreeRemote('https://github.com/tanaabased/openclaw-agent-system.git'),
      'git@github.com:tanaabased/openclaw-agent-system.git',
    );
    for (const remote of [
      'http://github.com/tanaabased/openclaw-agent-system.git',
      'https://example.com/tanaabased/openclaw-agent-system.git',
      'https://github.com/tanaabased/openclaw-agent-system',
      'https://github.com/tanaabased/nested/openclaw-agent-system.git',
    ]) {
      assert.throws(() => githubSshWorktreeRemote(remote), /canonical HTTPS/u, remote);
    }
  });

  it('should prefer ssh only for canonical github https remotes', () => {
    assert.equal(
      preferGitHubSshWorktreeRemote('https://github.com/tanaabased/openclaw-agent-system.git'),
      'git@github.com:tanaabased/openclaw-agent-system.git',
    );
    for (const remote of [
      'https://example.com/tanaabased/openclaw-agent-system.git',
      'ssh://git@example.com/tanaabased/openclaw-agent-system.git',
      'git@github.com:tanaabased/openclaw-agent-system.git',
    ]) {
      assert.equal(preferGitHubSshWorktreeRemote(remote), remote);
    }
  });
});
