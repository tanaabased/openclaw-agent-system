import assert from 'node:assert/strict';

import {
  classifyGitOperation,
  gitOperationProtections,
  type GitProtectedOperation,
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
      ['commit', '--amend', '--no-edit'],
      ['branch', '-D', 'old'],
      ['checkout', '--', 'tracked.txt'],
      ['clean', '-fd'],
      ['fetch', '--force', 'origin'],
      ['notes', 'add', '-m', 'example'],
      ['pull', '--rebase', 'origin', 'main'],
      ['push', 'origin'],
      ['rebase', 'main'],
      ['reset', '--hard', 'HEAD~1'],
      ['restore', 'tracked.txt'],
      ['sparse-checkout', 'set', 'src'],
      ['tag', '-f', 'release'],
    ]) {
      assert.equal(classifyGitOperation({ argv }).risk, 'write', argv.join(' '));
    }
  });

  it('should select explicit remote protections from every supported push spelling', () => {
    const cases: Array<{ argv: string[]; protections: GitProtectedOperation[] }> = [
      { argv: ['push', '--force', 'origin', 'main'], protections: ['forcePush'] },
      { argv: ['push', '--for', 'origin', 'main'], protections: ['forcePush'] },
      { argv: ['push', '-f', 'origin', 'main'], protections: ['forcePush'] },
      { argv: ['push', '-qf', 'origin', 'main'], protections: ['forcePush'] },
      {
        argv: ['push', '--force-with-lease=main', 'origin', 'main'],
        protections: ['forcePush'],
      },
      { argv: ['push', '--force-w', 'origin', 'main'], protections: ['forcePush'] },
      { argv: ['push', 'origin', '+main:main'], protections: ['forcePush'] },
      {
        argv: ['push', '--mirror', 'origin'],
        protections: ['forcePush', 'deleteRemoteRef'],
      },
      { argv: ['push', '--delete', 'origin', 'old'], protections: ['deleteRemoteRef'] },
      { argv: ['push', '--del', 'origin', 'old'], protections: ['deleteRemoteRef'] },
      { argv: ['push', '-d', 'origin', 'old'], protections: ['deleteRemoteRef'] },
      { argv: ['push', '-qd', 'origin', 'old'], protections: ['deleteRemoteRef'] },
      { argv: ['push', '--prune', 'origin'], protections: ['deleteRemoteRef'] },
      { argv: ['push', '--pru', 'origin'], protections: ['deleteRemoteRef'] },
      { argv: ['push', 'origin', ':old'], protections: ['deleteRemoteRef'] },
      {
        argv: ['push', 'origin', '+:old'],
        protections: ['forcePush', 'deleteRemoteRef'],
      },
      {
        argv: ['push', '--mi', 'origin'],
        protections: ['forcePush', 'deleteRemoteRef'],
      },
    ];

    for (const { argv, protections } of cases) {
      const operation = classifyGitOperation({ argv });
      assert.equal(operation.risk, 'destructive', argv.join(' '));
      assert.deepEqual(gitOperationProtections(operation), protections, argv.join(' '));
    }
  });

  it('should leave local mutation and non-protected remote operations as ordinary writes', () => {
    for (const argv of [
      ['push', 'origin', 'main'],
      ['fetch', 'origin', 'main'],
      ['fetch', '--prune-tags', 'origin'],
      ['pull', 'origin', 'main'],
      ['pull', '--rebase=false', 'origin', 'main'],
      ['push', '-oforce-check', 'origin', 'main'],
      ['push', '-qoforce-check', 'origin', 'main'],
      ['branch', '-m', 'renamed'],
      ['branch', '-D', 'old'],
      ['tag', 'release'],
      ['tag', '-f', 'release'],
      ['checkout', '-b', 'feature'],
      ['checkout', 'main'],
      ['checkout', '--', 'tracked.txt'],
      ['switch', 'main'],
      ['switch', '-c', 'feature'],
      ['reset', '--', 'tracked.txt'],
      ['reset', '--hard', 'HEAD~1'],
      ['restore', 'tracked.txt'],
      ['restore', '--staged', 'tracked.txt'],
      ['rebase', 'main'],
      ['rebase', '--abort'],
      ['commit', '--amend', '--no-edit'],
      ['clean', '-fd'],
      ['stash', 'clear'],
      ['reflog', 'expire', '--all'],
      ['gc'],
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
