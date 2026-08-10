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
  it('should allow ordinary reads and writes', () => {
    for (const argv of [['status'], ['log', '-1'], ['config', 'user.email']]) {
      const operation = classifyGitOperation({ argv });
      assert.equal(operation.risk, 'read');
      assert.deepEqual(authorizeGitOperation(operation, configuration), { status: 'allowed' });
    }
    for (const argv of [['init'], ['add', '.'], ['commit', '-m', 'example'], ['push', 'origin']]) {
      const operation = classifyGitOperation({ argv });
      assert.equal(operation.risk, 'write');
      assert.deepEqual(authorizeGitOperation(operation, configuration), { status: 'allowed' });
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
      {
        argv: ['worktree', 'remove', '--force', 'old'],
        hazards: ['force', 'discard', 'delete'],
      },
      { argv: ['reflog', 'expire', '--all'], hazards: ['delete'] },
      { argv: ['gc'], hazards: ['delete'] },
      { argv: ['prune'], hazards: ['delete'] },
      { argv: ['rm', '--force', 'tracked.txt'], hazards: ['force', 'discard'] },
      { argv: ['filter-branch', '--', '--all'], hazards: ['rewrite'] },
    ];

    for (const { argv, hazards } of cases) {
      const operation = classifyGitOperation({ argv });
      assert.equal(operation.risk, 'destructive', argv.join(' '));
      assert.deepEqual(gitOperationHazards(operation), hazards, argv.join(' '));
      assert.equal(authorizeGitOperation(operation, configuration).status, 'denied');
    }
  });

  it('should preserve explicit non-destructive alternatives as reads or writes', () => {
    for (const argv of [
      ['push', 'origin', 'main'],
      ['fetch', 'origin', 'main'],
      ['pull', 'origin', 'main'],
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
      ['worktree', 'prune', '--dry-run'],
    ]) {
      assert.equal(classifyGitOperation({ argv }).risk, 'read', argv.join(' '));
    }
  });

  it('should require every applicable git hazard policy to allow the operation', () => {
    const forcePush = classifyGitOperation({ argv: ['push', '--force', 'origin', 'main'] });
    assert.equal(
      authorizeGitOperation(forcePush, {
        ...configuration,
        git: { policy: { force: 'ask', rewrite: 'allow' } },
      }).status,
      'approval_required',
    );
    assert.equal(
      authorizeGitOperation(forcePush, {
        ...configuration,
        git: { policy: { force: 'allow', rewrite: 'deny' } },
      }).status,
      'denied',
    );
    assert.equal(
      authorizeGitOperation(classifyGitOperation({ argv: ['branch', '-d', 'old'] }), {
        ...configuration,
        git: { policy: { delete: 'allow' } },
      }).status,
      'allowed',
    );
  });

  it('should deny unknown commands and malformed destructive classifications by default', () => {
    assert.equal(
      authorizeGitOperation(classifyGitOperation({ argv: ['new-command'] }), configuration).status,
      'denied',
    );
    assert.equal(
      authorizeGitOperation(
        { action: 'git.cli.invoke', risk: 'destructive', summary: 'Run git example' },
        configuration,
      ).status,
      'denied',
    );
  });
});
