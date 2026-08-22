import assert from 'node:assert/strict';

import resolveGitHubNotificationModeCapability from '../channels/github/modes/capability.ts';
import GitHubNotificationModeRegistry from '../channels/github/modes/registry.ts';
import type { GitHubNotificationMode } from '../channels/github/modes/types.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';

describe('channels/github/modes/registry', () => {
  it('should inherit an explicitly configured coding profile for work', () => {
    const registry = new GitHubNotificationModeRegistry([githubNotificationWorkMode]);

    assert.deepEqual(
      resolveGitHubNotificationModeCapability(
        registry.resolve('work'),
        {
          agents: { list: [{ id: 'notification-data', tools: { profile: 'coding' } }] },
          tools: { profile: 'minimal' },
        },
        'notification-data',
      ),
      { disableTools: false, id: 'work' },
    );
  });

  it('should reject a work turn without the configured coding profile', () => {
    const registry = new GitHubNotificationModeRegistry([githubNotificationWorkMode]);

    assert.throws(
      () =>
        resolveGitHubNotificationModeCapability(
          registry.resolve('work'),
          {
            agents: { list: [{ id: 'notification-data' }] },
            tools: { profile: 'minimal' },
          },
          'notification-data',
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'github-notification-work-capability-profile-mismatch',
    );
  });

  it('should project a declared allowlist without reading configured tools', () => {
    const planMode: GitHubNotificationMode = {
      instructions: 'Plan the current request.',
      policy: {
        id: 'plan',
        label: 'Plan',
        toolProjection: { kind: 'allowlist', tools: ['agent_system_github_reply'] },
      },
    };

    assert.deepEqual(resolveGitHubNotificationModeCapability(planMode, {}, 'notification-data'), {
      disableTools: false,
      id: 'plan',
      toolsAllow: ['agent_system_github_reply'],
    });
  });

  it('should leave dormant modes unwired', () => {
    const registry = new GitHubNotificationModeRegistry([githubNotificationWorkMode]);

    assert.throws(() => registry.resolve('plan'), /not implemented/u);
    assert.throws(() => registry.resolve('auto'), /not implemented/u);
  });

  it('should reject duplicate mode definitions', () => {
    assert.throws(
      () =>
        new GitHubNotificationModeRegistry([
          githubNotificationWorkMode,
          githubNotificationWorkMode,
        ]),
      /Duplicate GitHub notification mode work/u,
    );
  });
});
