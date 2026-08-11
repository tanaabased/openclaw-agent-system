import assert from 'node:assert/strict';

import type { AgentSystemOperation } from '../lib/tool-types.ts';
import type { GitToolConfiguration } from '../tools/git/config-schema.ts';
import { classifyGitOperation } from '../tools/git/operation-classifier.ts';
import { authorizeGitOperation } from '../tools/git/policy.ts';

const configuration: GitToolConfiguration = {
  agent: { email: 'agent@example.com', name: 'Agent' },
  git: {},
};

function operation(risk: AgentSystemOperation['risk']): AgentSystemOperation {
  return { action: 'git.cli.invoke', risk, summary: `Run ${risk} Git operation` };
}

describe('tools/git/policy', () => {
  it('should allow ordinary reads and writes', async () => {
    assert.deepEqual(await authorizeGitOperation(operation('read'), configuration), {
      status: 'allowed',
    });
    assert.deepEqual(await authorizeGitOperation(operation('write'), configuration), {
      status: 'allowed',
    });
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
      (await authorizeGitOperation(operation('destructive'), configuration)).status,
      'denied',
    );
  });
});
