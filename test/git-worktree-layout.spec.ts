import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import resolveGitWorktreeLayout from '../tools/git/worktree-layout.ts';

describe('tools/git/worktree-layout', () => {
  it('should resolve a catch-all working directory separately from managed storage', () => {
    const layout = resolveGitWorktreeLayout(
      '/workspace',
      {
        repositories: {
          workingDirectory: '~/checkouts',
          local: { 'github-10': '../explicit' },
        },
      },
      '/home/test',
    );
    assert.equal(layout.workingDirectory, '/home/test/checkouts');
    assert.equal(layout.localRepositories['github-10'], '/explicit');
    assert.equal(layout.repositoryRoot, '/workspace/.agent-system/repositories');
    assert.equal(
      resolveGitWorktreeLayout(
        '/home/test/tanaab/me',
        {
          repositories: { workingDirectory: '~/tanaab' },
        },
        '/home/test',
      ).workingDirectory,
      '/home/test/tanaab',
    );
    assert.throws(
      () =>
        resolveGitWorktreeLayout('/workspace', {
          repositories: {
            workingDirectory: '.agent-system/repositories/checkouts',
          },
        }),
      /separate directories/u,
    );
  });
  it('should resolve workspace defaults and local repository overrides', () => {
    assert.deepEqual(
      resolveGitWorktreeLayout(
        '/workspace/data',
        {
          repositories: {
            local: {
              canon: '~/tanaab/canon',
              sibling: '../sibling',
            },
          },
        },
        '/home/test',
      ),
      {
        ignoreEntries: ['/.agent-system/repositories/', '/.agent-system/worktrees/'],
        localRepositories: {
          canon: '/home/test/tanaab/canon',
          sibling: '/workspace/sibling',
        },
        repositoryRoot: '/workspace/data/.agent-system/repositories',
        worktreeRoot: '/workspace/data/.agent-system/worktrees',
        workspaceDir: '/workspace/data',
      },
    );
  });

  it('should allow explicit external roots without workspace ignore entries', () => {
    const layout = resolveGitWorktreeLayout('/workspace/data', {
      root: '/var/agent/worktrees',
      repositories: { root: '/var/agent/repositories' },
    });

    assert.deepEqual(layout.ignoreEntries, []);
    assert.equal(layout.worktreeRoot, resolve('/var/agent/worktrees'));
  });

  it('should anchor and escape workspace gitignore entries', () => {
    const layout = resolveGitWorktreeLayout('/workspace/data', {
      root: '#managed/[worktrees]',
    });

    assert.deepEqual(layout.ignoreEntries, [
      '/.agent-system/repositories/',
      '/\\#managed/\\[worktrees\\]/',
    ]);
  });

  it('should reject overlapping managed roots and other-user home paths', () => {
    assert.throws(
      () =>
        resolveGitWorktreeLayout('/workspace/data', {
          root: '.agent-system',
          repositories: { root: '.agent-system/repositories' },
        }),
      /separate directories/u,
    );
    assert.throws(
      () => resolveGitWorktreeLayout('/workspace/data', { root: '~other/worktrees' }),
      /another user home/u,
    );
    assert.throws(
      () =>
        resolveGitWorktreeLayout('/workspace/data', {
          repositories: { local: { nested: '.agent-system/worktrees/nested' } },
        }),
      /inside managed roots/u,
    );
  });
});
