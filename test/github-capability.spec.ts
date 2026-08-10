import assert from 'node:assert/strict';

import createGitHubCapability from '../tools/github/capability.ts';

describe('tools/github/capability', () => {
  it('should assemble the github lifecycle and owned tool', () => {
    const capability = createGitHubCapability({
      baseEnvironment: { PATH: '/usr/bin' },
      environmentService: {
        async loadForWorkspace() {
          throw new Error('not used during capability assembly');
        },
      },
      excludedExecutableDirectories: ['/package/bin'],
      privateStateRoot: '/private',
    });

    assert.deepEqual(
      capability.lifecycleContributions.map(({ id }) => id),
      ['github'],
    );
    assert.deepEqual(
      capability.tools.map(({ id }) => id),
      ['github'],
    );
  });
});
