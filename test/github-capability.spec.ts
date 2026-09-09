import assert from 'node:assert/strict';

import createGitHubCapability from '../tools/github/capability.ts';

describe('tools/github/capability', () => {
  it('should assemble the github lifecycle and owned tool', () => {
    const capability = createGitHubCapability({
      baseEnvironment: { PATH: '/usr/bin' },
      async runCli() {
        throw new Error('not used during capability assembly');
      },
      environmentService: {
        async loadForWorkspace() {
          throw new Error('not used during capability assembly');
        },
      },
      excludedExecutableDirectories: ['/package/bin'],
      async mutateConfigFile() {
        throw new Error('not used during capability assembly');
      },
      openClawStateDir: '/openclaw',
      privateStateRoot: '/private',
      readConfig() {
        throw new Error('not used during capability assembly');
      },
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
