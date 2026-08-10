import assert from 'node:assert/strict';

import {
  gitWorktreeDefaultBranch,
  gitWorktreeDirectoryName,
  gitWorktreeRepositoryDirectoryName,
} from '../tools/git/worktree-names.ts';

describe('tools/git/worktree-names', () => {
  it('should derive stable bounded repository, worktree, and branch names', () => {
    assert.match(
      gitWorktreeRepositoryDirectoryName('tanaabased/openclaw-agent-system'),
      /^tanaabased-openclaw-agent-system-[a-f0-9]{10}\.git$/u,
    );
    const directory = gitWorktreeDirectoryName('owner/repository', 'issue-123');
    assert.match(directory, /^issue-123-[a-f0-9]{10}$/u);
    assert.equal(
      gitWorktreeDefaultBranch('owner/repository', 'issue-123'),
      `agent-system/${directory}`,
    );
  });
});
