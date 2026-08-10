import assert from 'node:assert/strict';

import {
  classifyGitOperation,
  gitOperationHazards,
  type GitPolicyHazard,
} from '../tools/git/operation-classifier.ts';

describe('tools/git/operation-classifier', () => {
  it('should classify ordinary reads and writes', () => {
    for (const argv of [
      ['status'],
      ['log', '-1'],
      ['config', 'user.email'],
      ['archive', 'HEAD'],
      ['bundle', 'verify', 'example.bundle'],
      ['show-branch'],
      ['sparse-checkout', 'list'],
      ['worktree', 'list'],
    ]) {
      assert.equal(classifyGitOperation({ argv }).risk, 'read', argv.join(' '));
    }
    for (const argv of [
      ['init'],
      ['add', '.'],
      ['bisect', 'start'],
      ['bundle', 'create', 'example.bundle', 'main'],
      ['commit', '-m', 'example'],
      ['notes', 'add', '-m', 'example'],
      ['push', 'origin'],
      ['sparse-checkout', 'set', 'src'],
    ]) {
      assert.equal(classifyGitOperation({ argv }).risk, 'write', argv.join(' '));
    }
  });

  it('should classify git-specific hazards before unknown policy applies', () => {
    const cases: Array<{ argv: string[]; hazards: GitPolicyHazard[] }> = [
      { argv: ['push', '--force', 'origin', 'main'], hazards: ['force', 'rewrite'] },
      { argv: ['push', 'origin', '+main:main'], hazards: ['force', 'rewrite'] },
      {
        argv: ['push', '--mirror', 'origin'],
        hazards: ['force', 'rewrite', 'delete'],
      },
      { argv: ['push', '--delete', 'origin', 'old'], hazards: ['delete'] },
      { argv: ['fetch', '--force', 'origin'], hazards: ['force', 'rewrite'] },
      { argv: ['fetch', '--prune-tags', 'origin'], hazards: ['delete'] },
      { argv: ['pull', '--rebase', 'origin', 'main'], hazards: ['rewrite'] },
      { argv: ['branch', '-D', 'old'], hazards: ['force', 'delete'] },
      { argv: ['branch', '-M', 'main'], hazards: ['force', 'rewrite'] },
      { argv: ['tag', '-f', 'release'], hazards: ['force', 'rewrite'] },
      { argv: ['checkout', '-B', 'main'], hazards: ['force', 'rewrite'] },
      { argv: ['switch', '-C', 'main'], hazards: ['force', 'rewrite'] },
      { argv: ['reset', '--hard', 'HEAD~1'], hazards: ['rewrite', 'discard'] },
      { argv: ['clean', '-fd'], hazards: ['discard'] },
      { argv: ['restore', 'tracked.txt'], hazards: ['discard'] },
      { argv: ['checkout', '--', 'tracked.txt'], hazards: ['discard'] },
      { argv: ['checkout', 'main'], hazards: ['discard'] },
      { argv: ['rebase', 'main'], hazards: ['rewrite'] },
      { argv: ['commit', '--amend', '--no-edit'], hazards: ['rewrite'] },
      { argv: ['stash', 'clear'], hazards: ['delete'] },
      { argv: ['notes', 'remove', 'HEAD'], hazards: ['delete'] },
      { argv: ['notes', '--ref', 'review', 'remove', 'HEAD'], hazards: ['delete'] },
      { argv: ['rerere', 'gc'], hazards: ['delete'] },
      { argv: ['reflog', 'expire', '--all'], hazards: ['delete'] },
      { argv: ['gc'], hazards: ['delete'] },
      { argv: ['maintenance', 'run'], hazards: ['delete'] },
      { argv: ['prune'], hazards: ['delete'] },
      { argv: ['repack', '-d'], hazards: ['delete'] },
      { argv: ['rm', '--force', 'tracked.txt'], hazards: ['force', 'discard'] },
      { argv: ['filter-branch', '--', '--all'], hazards: ['rewrite'] },
    ];

    for (const { argv, hazards } of cases) {
      const operation = classifyGitOperation({ argv });
      assert.equal(operation.risk, 'destructive', argv.join(' '));
      assert.deepEqual(gitOperationHazards(operation), hazards, argv.join(' '));
    }
  });

  it('should preserve explicit non-destructive alternatives', () => {
    for (const argv of [
      ['push', 'origin', 'main'],
      ['fetch', 'origin', 'main'],
      ['pull', 'origin', 'main'],
      ['pull', '--rebase=false', 'origin', 'main'],
      ['branch', '-m', 'renamed'],
      ['tag', 'release'],
      ['checkout', '-b', 'feature'],
      ['switch', 'main'],
      ['switch', '-c', 'feature'],
      ['reset', '--', 'tracked.txt'],
      ['restore', '--staged', 'tracked.txt'],
      ['rebase', '--abort'],
      ['rm', 'tracked.txt'],
    ]) {
      assert.equal(classifyGitOperation({ argv }).risk, 'write', argv.join(' '));
    }
    for (const argv of [
      ['clean', '--dry-run'],
      ['reflog', 'expire', '--dry-run', '--all'],
    ]) {
      assert.equal(classifyGitOperation({ argv }).risk, 'read', argv.join(' '));
    }
  });

  it('should classify raw worktree mutation as unknown', () => {
    assert.equal(
      classifyGitOperation({ argv: ['worktree', 'add', '../outside', 'main'] }).risk,
      'unknown',
    );
  });

  it('should classify supported public git command families instead of extensions', () => {
    for (const command of [
      'check-attr',
      'check-ignore',
      'check-mailmap',
      'check-ref-format',
      'cherry',
      'diff-files',
      'diff-index',
      'difftool',
      'fast-export',
      'interpret-trailers',
      'merge-tree',
      'patch-id',
      'range-diff',
      'request-pull',
      'var',
      'verify-commit',
      'verify-tag',
    ]) {
      assert.equal(classifyGitOperation({ argv: [command] }).risk, 'read', command);
    }
    for (const command of [
      'backfill',
      'bugreport',
      'diagnose',
      'mergetool',
      'pack-refs',
      'stage',
    ]) {
      assert.equal(classifyGitOperation({ argv: [command] }).risk, 'write', command);
    }
  });
});
