import assert from 'node:assert/strict';

import {
  gitHubIssueBranchName,
  gitHubIssueBranchSuffix,
  gitWorktreeDirectoryName,
  gitWorktreeRepositoryDirectoryName,
  isGitHubIssueBranchName,
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

  it('should bound readable issue branches and retain an issue-scoped fallback', () => {
    const suffix = gitHubIssueBranchSuffix('data', '/workspace/data', 'github-7', 'issue-3');
    assert.match(suffix, /^[a-f0-9]{5}$/u);
    assert.equal(gitHubIssueBranchName(42, 'Fix bad thing', suffix), `42-fix-bad-thing-${suffix}`);
    assert.equal(gitHubIssueBranchName(42, '🦞💥', suffix), `42-issue-${suffix}`);
    const long = gitHubIssueBranchName(42, `${'a'.repeat(47)} - ${'b'.repeat(100)}`, suffix);
    assert.equal(long, `42-${'a'.repeat(47)}-${suffix}`);
    assert.equal(isGitHubIssueBranchName(long, 42, suffix), true);
    assert.equal(isGitHubIssueBranchName(long, 43, suffix), false);
    assert.notEqual(
      suffix,
      gitHubIssueBranchSuffix('other', '/workspace/data', 'github-7', 'issue-3'),
    );
  });
});
