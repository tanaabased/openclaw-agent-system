import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSystemCliRunRequest } from '../api/types.ts';
import GitHubAccountClient from '../core/github-account-client.ts';
import type { AgentManifest } from '../manifest/types.ts';

const syntheticToken = 'synthetic-ci-value-not-a-credential';
const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'notification-data' },
  github: { username: 'fixture-data', token: 'GH_TOKEN_FIXTURE' },
};

describe('github operator-access disposable provider', () => {
  let root = '';
  let executable = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'operator-provider-'));
    await mkdir(join(root, 'bin'));
    executable = join(root, 'bin/fake-gh.mjs');
    await copyFile('scenarios/issue-work-operator-access/fake-gh.mjs', executable);
    await writeFile(
      join(root, 'state.json'),
      JSON.stringify({ fixture: 'operator-access-ci', items: [] }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function run(argv: string[], environment: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [executable, ...argv], {
      cwd: root,
      encoding: 'utf8',
      env: environment,
      timeout: 5000,
    });
  }

  it('should verify account and profile identities through the sanitized account client', async () => {
    const requests: AgentSystemCliRunRequest[] = [];
    const client = new GitHubAccountClient({
      baseEnvironment: { PATH: process.env.PATH, GITHUB_ACTIONS: 'true' },
      configStore: { configDirectory: () => join(root, 'config') },
      environmentService: {
        loadForWorkspace: async () => ({
          status: 'loaded',
          scope: { agentId: manifest.agent.id, workspaceDir: root },
          path: join(root, 'agent.yaml'),
          digest: 'fixture',
          manifest,
          diagnostics: [],
          validationChecks: [],
          environment: { values: { GH_TOKEN_FIXTURE: syntheticToken }, variables: [] },
        }),
      },
      runCli: async (request) => {
        requests.push(request);
        const result = run(request.argv, request.environment);
        return {
          exitCode: result.status,
          stderr: result.stderr,
          stdout: result.stdout,
          timedOut: false,
          truncated: false,
        };
      },
    });
    const connected = await client.connect({ manifest, workspaceDir: root });
    const identity = { login: 'fixture-data', nodeId: 'U_fixture-data' };
    assert.deepEqual(connected.identity, identity);
    assert.deepEqual(await connected.verifyConfiguredIdentity?.(join(root, 'profile')), identity);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ environment }) => environment.GITHUB_ACTIONS === undefined));
    assert.equal(requests[0]?.environment.GH_TOKEN, syntheticToken);
    assert.equal(requests[1]?.environment.GH_TOKEN, '');
  });

  it('should emit raw string projections for the native github tool preflight', () => {
    const result = run(['api', 'user', '--jq', '.login'], {
      PATH: process.env.PATH,
      GH_TOKEN: syntheticToken,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'fixture-data\n');
  });

  it('should reject unprepared state and non-synthetic credentials', async () => {
    const rejectedToken = run(['api', 'user'], {
      PATH: process.env.PATH,
      GH_TOKEN: 'not-the-fixture-token',
    });
    assert.notEqual(rejectedToken.status, 0);
    assert.match(rejectedToken.stderr, /accepts only synthetic credentials/u);
    await writeFile(join(root, 'state.json'), JSON.stringify({ items: [] }));
    const unprepared = run(['api', 'user'], { PATH: process.env.PATH });
    assert.notEqual(unprepared.status, 0);
    assert.match(unprepared.stderr, /Unprepared GitHub fixture/u);
  });
});
