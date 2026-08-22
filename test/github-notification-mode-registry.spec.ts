import assert from 'node:assert/strict';

import GitHubNotificationModeRegistry from '../channels/github/modes/registry.ts';

describe('channels/github/modes/registry', () => {
  it('should inherit an explicitly configured coding profile for work', () => {
    const registry = new GitHubNotificationModeRegistry();

    assert.deepEqual(
      registry.resolve('work').resolve(
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
    const registry = new GitHubNotificationModeRegistry();

    assert.throws(
      () =>
        registry.resolve('work').resolve(
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

  it('should leave dormant modes unwired', () => {
    const registry = new GitHubNotificationModeRegistry();

    assert.throws(() => registry.resolve('plan'), /not implemented/u);
    assert.throws(() => registry.resolve('auto'), /not implemented/u);
  });
});
