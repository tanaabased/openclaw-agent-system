import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'yaml';

import type { AgentSystemCliRunRequest } from '../api/types.ts';
import GitHubAccountClient from '../core/github-account-client.ts';
import type { AgentManifest } from '../manifest/types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { email: 'tanaabot@tanaab.dev', id: 'tanaabot', name: 'Tanaabot' },
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

describe('core/github-account-client', () => {
  it('should bind fixed calls to a sanitized child environment and configured identity', async () => {
    const requests: AgentSystemCliRunRequest[] = [];
    const controller = new AbortController();
    const root = await mkdtemp(join(tmpdir(), 'agent-system-github-profile-'));
    const profileDirectory = join(root, 'profile');
    await mkdir(profileDirectory);
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
          stdout: request.argv.includes('user')
            ? '{"login":"tanaabot","nodeId":"U_agent"}'
            : '[[]]',
          timedOut: false,
          truncated: false,
        };
      },
    });

    try {
      const connected = await client.connect(
        { manifest, workspaceDir },
        'service',
        controller.signal,
      );
      await connected.execute(['api', '--paginate', '--slurp', '/user/keys']);
      assert.ok(connected.materializeProfile);
      await connected.materializeProfile(profileDirectory);

      assert.deepEqual(
        requests.map(({ argv }) => argv),
        [
          ['api', 'user', '--jq', '{login:.login,nodeId:.node_id}'],
          ['api', '--paginate', '--slurp', '/user/keys'],
          ['api', 'user', '--jq', '{login:.login,nodeId:.node_id}'],
        ],
      );
      assert.equal(requests[1]?.environment.GH_TOKEN, 'private-token');
      assert.equal(requests[1]?.environment.GH_CONFIG_DIR, '/private/tanaabot/tools/gh');
      assert.equal(requests[1]?.environment.SHOULD_NOT_INHERIT, undefined);
      assert.equal(requests[0]?.signal, controller.signal);
      assert.equal(requests[1]?.signal, controller.signal);
      assert.deepEqual(requests[1]?.excludedExecutableDirectories, [
        `${workspaceDir}/bin`,
        `${workspaceDir}/commands`,
        '/package/bin',
      ]);
      assert.equal(requests[2]?.stdin, undefined);
      assert.equal(requests[2]?.environment.GH_TOKEN, '');
      assert.equal(requests[2]?.environment.GITHUB_TOKEN, '');
      assert.equal(requests[2]?.environment.GH_CONFIG_DIR, profileDirectory);
      assert.equal(JSON.stringify(requests[2]?.argv).includes('private-token'), false);
      assert.equal((await stat(join(profileDirectory, 'hosts.yml'))).mode & 0o077, 0);
      assert.equal((await stat(join(profileDirectory, 'config.yml'))).mode & 0o077, 0);
      assert.deepEqual(parse(await readFile(join(profileDirectory, 'hosts.yml'), 'utf8')), {
        'github.com': {
          oauth_token: 'private-token',
          user: 'tanaabot',
          users: { tanaabot: { oauth_token: 'private-token' } },
        },
      });
      assert.deepEqual(connected.gitAuthor, {
        email: 'tanaabot@tanaab.dev',
        name: 'Tanaabot',
      });
      assert.equal(
        connected.credentialFingerprint,
        createHash('sha256').update('private-token').digest('hex'),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('should redact credential failures while materializing an openclaw profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-github-profile-failure-'));
    const profileDirectory = join(root, 'profile');
    await mkdir(profileDirectory);
    await writeFile(join(profileDirectory, 'hosts.yml'), 'existing: true\n');
    const client = new GitHubAccountClient({
      baseEnvironment: { PATH: '/usr/bin' },
      configStore: { configDirectory: () => '/private/tanaabot/tools/gh' },
      environmentService: { loadForWorkspace: async () => loadedEnvironment() },
      runCli: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: '{"login":"tanaabot","nodeId":"U_agent"}',
        timedOut: false,
        truncated: false,
      }),
    });
    const connected = await client.connect({ manifest, workspaceDir });
    assert.ok(connected.materializeProfile);

    try {
      await assert.rejects(
        connected.materializeProfile(profileDirectory),
        (error: unknown) =>
          error instanceof Error &&
          error.message === 'The managed GitHub account profile could not be materialized.' &&
          !error.message.includes('private-token'),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('should reject a github account that does not match the declaration', async () => {
    const client = new GitHubAccountClient({
      baseEnvironment: { PATH: '/usr/bin' },
      configStore: { configDirectory: () => '/private/tanaabot/tools/gh' },
      environmentService: { loadForWorkspace: async () => loadedEnvironment() },
      runCli: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: '{"login":"someone-else","nodeId":"U_other"}',
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
