import assert from 'node:assert/strict';

import {
  authorizeGitOperation,
  classifyGitOperation,
  gitOperationHazards,
  type GitPolicyHazard,
} from '../tools/git/policy.ts';
import type { GitToolConfiguration } from '../tools/git/config-schema.ts';

const configuration: GitToolConfiguration = {
  agent: { email: 'agent@example.com', name: 'Agent' },
  git: {},
};

describe('tools/git/policy', () => {
  it('should allow ordinary reads and writes', async () => {
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
      const operation = classifyGitOperation({ argv });
      assert.equal(operation.risk, 'read');
      assert.deepEqual(await authorizeGitOperation(operation, configuration), {
        status: 'allowed',
      });
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
      const operation = classifyGitOperation({ argv });
      assert.equal(operation.risk, 'write');
      assert.deepEqual(await authorizeGitOperation(operation, configuration), {
        status: 'allowed',
      });
    }
  });

  it('should classify git-specific hazards before unknown policy applies', async () => {
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
      assert.equal((await authorizeGitOperation(operation, configuration)).status, 'denied');
    }
  });

  it('should preserve explicit non-destructive alternatives as reads or writes', () => {
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

  it('should deny every raw worktree mutation independently of unknown policy', async () => {
    for (const argv of [
      ['worktree'],
      ['worktree', 'add', '../outside', 'main'],
      ['worktree', 'move', 'old', '../outside'],
      ['worktree', 'remove', '--force', 'old'],
      ['worktree', 'repair'],
      ['worktree', 'lock', 'old'],
      ['worktree', 'unlock', 'old'],
      ['worktree', 'prune', '--dry-run'],
      ['worktree', 'future-command'],
    ]) {
      const operation = classifyGitOperation({ argv });
      assert.equal(operation.risk, 'unknown', argv.join(' '));
      const decision = await authorizeGitOperation(operation, {
        ...configuration,
        git: { policy: { unknown: 'allow' } },
      });
      assert.equal(decision.status, 'denied', argv.join(' '));
      assert.match(decision.reason, /raw git worktree mutation/iu, argv.join(' '));
    }
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

  it('should require every applicable git hazard policy to allow the operation', async () => {
    const forcePush = classifyGitOperation({ argv: ['push', '--force', 'origin', 'main'] });
    assert.equal(
      (
        await authorizeGitOperation(forcePush, {
          ...configuration,
          git: { policy: { force: 'ask', rewrite: 'allow' } },
        })
      ).status,
      'approval_required',
    );
    assert.equal(
      (
        await authorizeGitOperation(forcePush, {
          ...configuration,
          git: { policy: { force: 'allow', rewrite: 'deny' } },
        })
      ).status,
      'denied',
    );
    assert.equal(
      (
        await authorizeGitOperation(classifyGitOperation({ argv: ['branch', '-d', 'old'] }), {
          ...configuration,
          git: { policy: { delete: 'allow' } },
        })
      ).status,
      'allowed',
    );
  });

  it('should apply exact extension policy only to available external helpers', async () => {
    const extension = classifyGitOperation({ argv: ['town', 'status'] });
    assert.equal(extension.risk, 'unknown');
    assert.equal(extension.attributes?.['git.extension'], 'town');

    assert.equal(
      (
        await authorizeGitOperation(
          extension,
          { ...configuration, git: { extensions: { town: 'allow' } } },
          { extensionAvailable: async (name) => name === 'town' },
        )
      ).status,
      'allowed',
    );
    assert.equal(
      (
        await authorizeGitOperation(
          extension,
          { ...configuration, git: { extensions: { town: 'ask' } } },
          { extensionAvailable: () => true },
        )
      ).status,
      'approval_required',
    );
    assert.equal(
      (
        await authorizeGitOperation(
          extension,
          {
            ...configuration,
            git: { extensions: { town: 'deny' }, policy: { unknown: 'allow' } },
          },
          { extensionAvailable: () => true },
        )
      ).status,
      'denied',
    );
    const unavailable = await authorizeGitOperation(
      extension,
      { ...configuration, git: { extensions: { town: 'allow' } } },
      { extensionAvailable: () => false },
    );
    assert.equal(unavailable.status, 'denied');
    assert.match(unavailable.reason, /external git-town executable/u);
  });

  it('should keep built-in hazards ahead of matching extension declarations', async () => {
    const forcePush = classifyGitOperation({ argv: ['push', '--force', 'origin', 'main'] });
    assert.equal(
      (
        await authorizeGitOperation(
          forcePush,
          {
            ...configuration,
            git: { extensions: { push: 'allow' }, policy: { force: 'deny', rewrite: 'allow' } },
          },
          { extensionAvailable: () => true },
        )
      ).status,
      'denied',
    );
  });

  it('should deny unknown commands and malformed destructive classifications by default', async () => {
    assert.equal(
      (await authorizeGitOperation(classifyGitOperation({ argv: ['new-command'] }), configuration))
        .status,
      'denied',
    );
    assert.equal(
      (
        await authorizeGitOperation(
          { action: 'git.cli.invoke', risk: 'destructive', summary: 'Run git example' },
          configuration,
        )
      ).status,
      'denied',
    );
  });
});
