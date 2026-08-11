import assert from 'node:assert/strict';

import WorkspaceGitignoreService from '../lib/workspace-gitignore-service.ts';
import createGitCapability from '../tools/git/capability.ts';

describe('tools/git/capability', () => {
  it('should assemble the git lifecycle and owned tools', () => {
    const capability = createGitCapability({
      baseEnvironment: { PATH: '/usr/bin' },
      excludedExecutableDirectories: ['/package/bin'],
      gitignoreService: new WorkspaceGitignoreService(),
      packageDir: '/package',
    });

    assert.deepEqual(
      capability.lifecycleContributions.map(({ id }) => id),
      ['git'],
    );
    assert.deepEqual(
      capability.tools.map(({ id }) => id),
      ['git', 'git-worktree'],
    );
  });
});
