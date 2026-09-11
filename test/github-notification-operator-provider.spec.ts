import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AgentSystemCliRunRequest } from '../api/types.ts';
import GitHubAccountClient from '../core/github-account-client.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { updateFixtureState } from '../scenarios/issue-work-operator-access/state.mjs';

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
    executable = resolve('scenarios/issue-work-operator-access/fake-gh.mjs');
    await writeFile(
      join(root, 'state.json'),
      JSON.stringify({ fixture: 'operator-access-ci', items: [] }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function run(argv: string[], environment: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [executable, join(root, 'state.json'), ...argv], {
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

  it('should preserve newly added issues while a delayed comment request finishes', async () => {
    const statePath = join(root, 'state.json');
    await updateFixtureState(statePath, (state: { items: unknown[] }) => {
      state.items.push({ id: 101, number: 1, comments: [] });
    });
    // pause the real provider at stdin, after its initial read but before publication.
    const bootstrap = `
      const fs = require('node:fs');
      const original = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        if (path === 0) process.stderr.write('snapshot-read\\n');
        return original.call(this, path, ...args);
      };
      require('node:module').syncBuiltinESMExports();
      const [executable, state] = process.argv.slice(1);
      process.argv = [process.execPath, executable, state, 'api',
        '/repos/tanaabased/operator-fixture/issues/1/comments', '--method', 'POST'];
      import(require('node:url').pathToFileURL(executable).href);
    `;
    const child = spawn(process.execPath, ['-e', bootstrap, executable, statePath], {
      env: { PATH: process.env.PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const exited = once(child, 'close');
    try {
      const [signal] = await once(child.stderr, 'data');
      assert.equal(String(signal), 'snapshot-read\n');
      await updateFixtureState(statePath, (state: { items: unknown[] }) => {
        state.items.push({ id: 102, number: 2, comments: [] });
      });
      child.stdin.end(JSON.stringify({ body: 'delayed fixture publication' }));
      const [code] = await exited;
      assert.equal(code, 0);
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      assert.deepEqual(
        state.items.map((item: { number: number }) => item.number),
        [1, 2],
      );
      assert.equal(state.items[0].comments.length, 1);
    } finally {
      child.kill();
      await exited;
    }
  });

  it('should serialize overlapping writers and release failed updates without partial data', async () => {
    const statePath = join(root, 'state.json');
    await Promise.all(
      [1, 2, 3].map((number) =>
        updateFixtureState(statePath, async (state: { items: number[] }) => {
          state.items.push(number);
          await Promise.resolve();
        }),
      ),
    );
    const before = await readFile(statePath, 'utf8');
    assert.deepEqual(JSON.parse(before).items.sort(), [1, 2, 3]);
    await assert.rejects(
      updateFixtureState(statePath, (state: { items: number[] }) => {
        state.items.push(4);
        throw new Error('fixture mutation failed');
      }),
      /fixture mutation failed/u,
    );
    assert.equal(await readFile(statePath, 'utf8'), before);
    await updateFixtureState(statePath, (state: { items: number[] }) => {
      state.items.push(5);
    });
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).items.sort(), [1, 2, 3, 5]);
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
