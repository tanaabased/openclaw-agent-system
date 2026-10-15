import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubConfigStore from '../tools/github/config-store.ts';
import {
  defaultGitHubCliConfiguration,
  resolveGitHubCliConfiguration,
} from '../tools/github/config-schema.ts';

describe('tools/github/config-store', () => {
  let temporaryRoot = '';
  let stateRoot = '';

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-system-github-config-'));
    stateRoot = join(temporaryRoot, 'state', 'agent-system');
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true });
  });

  it('should apply token-free defaults and reconcile only missing or drifted config', async () => {
    const store = new GitHubConfigStore({ currentUid: process.getuid?.(), rootDir: stateRoot });

    assert.deepEqual(resolveGitHubCliConfiguration({}), defaultGitHubCliConfiguration);
    assert.equal((await store.reconcile('data', defaultGitHubCliConfiguration)).status, 'created');
    assert.equal(
      (await store.reconcile('data', defaultGitHubCliConfiguration)).status,
      'unchanged',
    );

    const configPath = join(store.configDirectory('data'), 'config.yml');
    const contents = await readFile(configPath, 'utf8');
    assert.match(contents, /^git_protocol: ssh$/m);
    assert.match(contents, /^color_labels: enabled$/m);
    assert.match(contents, /^accessible_colors: disabled$/m);
    assert.match(contents, /^prompt: disabled$/m);
    assert.match(contents, /^spinner: enabled$/m);
    assert.match(contents, /^telemetry: disabled$/m);
    assert.match(contents, /^version: "1"$/m);
    assert.equal(contents.includes('token'), false);
    assert.equal((await lstat(store.configDirectory('data'))).mode & 0o077, 0);
    assert.equal((await lstat(configPath)).mode & 0o077, 0);

    const changed = { ...defaultGitHubCliConfiguration, gitProtocol: 'https' as const };
    assert.equal((await store.reconcile('data', changed)).status, 'updated');
    assert.match(await readFile(configPath, 'utf8'), /^git_protocol: https$/m);
  });

  it('should reject a symbolic-link config directory and a public config file', async () => {
    const agentTools = join(stateRoot, 'data', 'tools');
    const external = join(temporaryRoot, 'external');
    await mkdir(agentTools, { recursive: true, mode: 0o700 });
    await mkdir(external, { mode: 0o700 });
    await symlink(external, join(agentTools, 'gh'));
    const store = new GitHubConfigStore({ currentUid: process.getuid?.(), rootDir: stateRoot });

    await assert.rejects(
      store.reconcile('data', defaultGitHubCliConfiguration),
      /must be real directories/,
    );

    await rm(join(agentTools, 'gh'));
    await store.reconcile('data', defaultGitHubCliConfiguration);
    const configPath = join(store.configDirectory('data'), 'config.yml');
    await chmod(configPath, 0o644);
    await assert.rejects(store.inspect('data', defaultGitHubCliConfiguration), /must be private/);
  });
});
