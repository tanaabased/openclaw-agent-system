import assert from 'node:assert/strict';

import type { AgentSystemCliRunRequest } from '../lib/tool-types.ts';
import GitHubAccountClient from '../tools/github/account-client.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'tanaabot' },
  environment: { pathPrepend: ['commands'] },
  github: {
    sshKeys: [{ source: 'keys/auth.pub', type: 'path' }],
    token: 'GH_TOKEN_TANAABOT',
    username: { fromEnvironment: 'GITHUB_USERNAME' },
  },
};
const workspaceDir = '/workspace/tanaabot';

function loadedEnvironment() {
  return {
    status: 'loaded' as const,
    scope: { agentId: 'tanaabot', workspaceDir },
    path: `${workspaceDir}/agent.yaml`,
    digest: 'digest',
    manifest,
    diagnostics: [],
    validationChecks: [],
    environment: {
      values: {
        GH_TOKEN_TANAABOT: 'private-token',
        GITHUB_USERNAME: 'tanaabot',
      },
      variables: [],
    },
  };
}

describe('tools/github/account-client', () => {
  it('should bind fixed calls to a sanitized child environment and configured identity', async () => {
    const requests: AgentSystemCliRunRequest[] = [];
    const client = new GitHubAccountClient({
      baseEnvironment: {
        HOME: '/home/runner',
        PATH: '/usr/bin',
        SHOULD_NOT_INHERIT: 'private-host-value',
      },
      configStore: { configDirectory: () => '/private/tanaabot/tools/gh' },
      environmentService: { loadForWorkspace: async () => loadedEnvironment() },
      excludedExecutableDirectories: ['/package/bin'],
      runCli: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stderr: '',
          stdout: request.argv.includes('user') ? 'tanaabot\n' : '[[]]',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const connected = await client.connect({ manifest, workspaceDir });
    await connected.execute(['api', '--paginate', '--slurp', '/user/keys']);

    assert.deepEqual(
      requests.map(({ argv }) => argv),
      [
        ['api', 'user', '--jq', '.login'],
        ['api', '--paginate', '--slurp', '/user/keys'],
      ],
    );
    assert.equal(requests[1]?.environment.GH_TOKEN, 'private-token');
    assert.equal(requests[1]?.environment.GH_CONFIG_DIR, '/private/tanaabot/tools/gh');
    assert.equal(requests[1]?.environment.SHOULD_NOT_INHERIT, undefined);
    assert.deepEqual(requests[1]?.excludedExecutableDirectories, [
      `${workspaceDir}/bin`,
      `${workspaceDir}/commands`,
      '/package/bin',
    ]);
  });

  it('should reject a github account that does not match the declaration', async () => {
    const client = new GitHubAccountClient({
      baseEnvironment: { PATH: '/usr/bin' },
      configStore: { configDirectory: () => '/private/tanaabot/tools/gh' },
      environmentService: { loadForWorkspace: async () => loadedEnvironment() },
      runCli: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: 'someone-else\n',
        timedOut: false,
        truncated: false,
      }),
    });

    await assert.rejects(
      client.connect({ manifest, workspaceDir }),
      /not the configured username tanaabot/u,
    );
  });
});
