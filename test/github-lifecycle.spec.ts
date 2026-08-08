import assert from 'node:assert/strict';

import createGitHubLifecycleContribution from '../tools/github/lifecycle.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data' },
  github: { config: { gitProtocol: 'https' } },
};
const context = { manifest, workspaceDir: '/workspace' };

describe('tools/github/lifecycle', () => {
  it('should validate and inspect generated github cli configuration', async () => {
    const contribution = createGitHubLifecycleContribution({
      configStore: {
        async inspect(agentId, configuration) {
          assert.equal(agentId, 'data');
          assert.equal(configuration.gitProtocol, 'https');
          return { configDir: '/private/data/tools/gh', status: 'ready' };
        },
        async reconcile() {
          throw new Error('reconcile should not run');
        },
      },
    });

    assert.deepEqual(contribution.validate?.(context), {
      summary: 'GitHub tool configuration',
    });
    assert.deepEqual(await contribution.inspect?.(context), [
      {
        code: 'github-config-ready',
        message: 'Generated GitHub CLI config matches the agent manifest.',
        status: 'healthy',
      },
    ]);
  });

  it('should reconcile and verify generated github cli configuration', async () => {
    const events: string[] = [];
    const contribution = createGitHubLifecycleContribution({
      configStore: {
        async reconcile(agentId, configuration) {
          events.push(`reconcile:${agentId}:${configuration.gitProtocol}`);
          return { configDir: '/private/data/tools/gh', status: 'created' };
        },
        async inspect(agentId, configuration) {
          events.push(`inspect:${agentId}:${configuration.gitProtocol}`);
          return { configDir: '/private/data/tools/gh', status: 'ready' };
        },
      },
    });

    assert.deepEqual(await contribution.reconcile?.(context), {
      outcomes: [
        {
          code: 'create-github-config',
          message: 'private GitHub CLI config',
          status: 'created',
        },
      ],
    });
    assert.deepEqual(events, ['reconcile:data:https', 'inspect:data:https']);
  });

  it('should report verified matching configuration as unchanged', async () => {
    const contribution = createGitHubLifecycleContribution({
      configStore: {
        async reconcile() {
          return { configDir: '/private/data/tools/gh', status: 'unchanged' };
        },
        async inspect() {
          return { configDir: '/private/data/tools/gh', status: 'ready' };
        },
      },
    });

    assert.deepEqual(await contribution.reconcile?.(context), {
      outcomes: [
        {
          code: 'github-config-unchanged',
          message: 'private GitHub CLI config',
          status: 'unchanged',
        },
      ],
    });
  });

  it('should convert unsafe inspection into a repair finding', async () => {
    const contribution = createGitHubLifecycleContribution({
      configStore: {
        async inspect() {
          throw new Error('The generated GitHub config must be private.');
        },
        async reconcile() {
          throw new Error('reconcile should not run');
        },
      },
    });

    assert.deepEqual(await contribution.inspect?.(context), [
      {
        code: 'github-config-unsafe',
        message: 'The generated GitHub config must be private.',
        remediation: 'Correct the private config path, then run openclaw agent-system install.',
        status: 'drift',
      },
    ]);
  });
});
