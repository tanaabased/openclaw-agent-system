import assert from 'node:assert/strict';

import {
  gitWorktreeDirectoryName,
  gitWorktreeRepositoryDirectoryName,
} from '../tools/git/worktree-names.ts';

describe('tools/git/worktree-names', () => {
  it('should derive stable bounded repository, worktree, and branch names', () => {
    assert.match(
      gitWorktreeRepositoryDirectoryName('tanaabased/openclaw-agent-system'),
      /^tanaabased-openclaw-agent-system-[a-f0-9]{10}\.git$/u,
    );
    assert.match(
      gitWorktreeDirectoryName('owner/repository', '123-fix-agent-path-resolution'),
      /^123-fix-agent-path-resolution-[a-f0-9]{10}$/u,
    );
    assert.notEqual(
      gitWorktreeDirectoryName('owner/repository', 'Issue 123'),
      gitWorktreeDirectoryName('owner/repository', 'issue-123'),
    );
  });
});
