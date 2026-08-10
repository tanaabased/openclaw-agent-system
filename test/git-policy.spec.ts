import assert from 'node:assert/strict';

import { authorizeGitOperation, classifyGitOperation } from '../tools/git/policy.ts';
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

  it('should classify destructive operations before unknown policy applies', () => {
    for (const argv of [
      ['push', '--force', 'origin', 'main'],
      ['push', 'origin', '+main:main'],
      ['push', '--mirror', 'origin'],
      ['push', '--prune', 'origin'],
      ['fetch', '--force', 'origin'],
      ['fetch', '--prune-tags', 'origin'],
      ['pull', '--prune', 'origin'],
      ['branch', '-D', 'old'],
      ['branch', '-M', 'main'],
      ['branch', '-C', 'copy'],
      ['tag', '-f', 'release'],
      ['checkout', '-B', 'main'],
      ['switch', '-C', 'main'],
      ['reset', '--hard', 'HEAD~1'],
      ['clean', '-fd'],
      ['prune'],
    ]) {
      const operation = classifyGitOperation({ argv });
      assert.equal(operation.risk, 'destructive');
      assert.equal(authorizeGitOperation(operation, configuration).status, 'denied');
    }
  });

  it('should preserve ordinary ref and branch updates as writes', () => {
    for (const argv of [
      ['push', 'origin', 'main'],
      ['fetch', 'origin', 'main'],
      ['pull', 'origin', 'main'],
      ['branch', '-m', 'renamed'],
      ['branch', '-c', 'copy'],
      ['tag', 'release'],
      ['checkout', '-b', 'feature'],
      ['switch', '-c', 'feature'],
    ]) {
      assert.equal(classifyGitOperation({ argv }).risk, 'write');
    }
  });

  it('should require native approval for ask and deny unknown commands by default', () => {
    const destructive = classifyGitOperation({ argv: ['push', '--delete', 'origin', 'old'] });
    assert.equal(
      authorizeGitOperation(destructive, {
        ...configuration,
        git: { policy: { destructive: 'ask' } },
      }).status,
      'approval_required',
    );
    assert.equal(
      authorizeGitOperation(classifyGitOperation({ argv: ['new-command'] }), configuration).status,
      'denied',
    );
  });
});
