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

  it('should require every selected git protection to allow the operation', async () => {
    const forcePush = classifyGitOperation({ argv: ['push', '--force', 'origin', 'main'] });
    const denied = await authorizeGitOperation(forcePush, {
      ...configuration,
      git: { policy: { forcePush: 'deny' } },
    });
    assert.equal(denied.status, 'denied');
    assert.match(denied.reason, /denied by git\.policy\.force-push/u);
    assert.match(denied.reason, /operator must set git\.policy\.force-push to allow/u);
    assert.equal(
      (
        await authorizeGitOperation(forcePush, {
          ...configuration,
          git: { policy: { forcePush: 'allow' } },
        })
      ).status,
      'allowed',
    );
    const mirror = classifyGitOperation({ argv: ['push', '--mirror', 'origin'] });
    assert.equal(
      (
        await authorizeGitOperation(mirror, {
          ...configuration,
          git: { policy: { forcePush: 'allow', deleteRemoteRef: 'deny' } },
        })
      ).status,
      'denied',
    );
    assert.equal(
      (
        await authorizeGitOperation(mirror, {
          ...configuration,
          git: { policy: { forcePush: 'allow', deleteRemoteRef: 'allow' } },
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
    const denied = await authorizeGitOperation(
      extension,
      {
        ...configuration,
        git: { extensions: { town: 'deny' } },
      },
      { extensionAvailable: () => true },
    );
    assert.equal(denied.status, 'denied');
    assert.match(denied.reason, /denied by git\.extensions\.town/u);
    assert.match(denied.reason, /operator must set git\.extensions\.town to allow/u);
    const unavailable = await authorizeGitOperation(
      extension,
      { ...configuration, git: { extensions: { town: 'allow' } } },
      { extensionAvailable: () => false },
    );
    assert.equal(unavailable.status, 'denied');
    assert.match(unavailable.reason, /external git-town executable/u);
    assert.match(unavailable.reason, /operator must install that executable/u);
  });

  it('should keep built-in protections ahead of matching extension declarations', async () => {
    const forcePush = classifyGitOperation({ argv: ['push', '--force', 'origin', 'main'] });
    assert.equal(
      (
        await authorizeGitOperation(
          forcePush,
          {
            ...configuration,
            git: { extensions: { push: 'allow' }, policy: { forcePush: 'deny' } },
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
