import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, delimiter } from 'node:path';

import { prepareHostCommand } from '../api/host-command.ts';

describe('api/host-command', function () {
  this.timeout(10_000);
  let root: string;
  let host: string;
  let managed: string;
  const fixture = new URL('./host-command-child.ts', import.meta.url).pathname;
  const tsx = createRequire(import.meta.url).resolve('tsx');

  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/host-command-'));
    host = join(root, 'host');
    managed = join(root, 'managed');
    await Promise.all([host, managed].map((path) => mkdir(path)));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should strip authority, credentials, identity, startup overrides, and launcher aliases', async () => {
    await writeFile(join(host, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(join(managed, 'gh'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    await symlink(join(managed, 'gh'), join(host, 'gh'));
    const environment = {
      PATH: [managed, '.', '', host].join(delimiter),
      HOME: root,
      AGENT_SYSTEM_TOOL_LAUNCHER_DIR: managed,
      AGENT_SYSTEM_EXEC_AUTHORITY: 'authority',
      AGENT_SYSTEM_EXEC_CAPABILITY: 'capability',
      AGENT_SYSTEM_GIT: '/strict/git',
      GIT_AUTHOR_NAME: 'agent',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'agent',
      GIT_SSH: '/agent/ssh',
      SSH_AUTH_SOCK: '/agent/socket',
      GH_TOKEN: 'private',
      GITHUB_TOKEN: 'private',
      GH_CONFIG_DIR: '/agent/gh',
      XDG_CONFIG_HOME: '/agent/config',
      CODEX_HOME: '/agent/codex',
      CODEX_THREAD_ID: 'thread',
      NODE_OPTIONS: '--require unsafe',
      CUSTOM_SECRET: 'private',
    };
    const result = await prepareHostCommand('git', environment);
    assert.equal(result.executable, join(host, 'git'));
    assert.deepEqual(result.environment, { HOME: root, PATH: '' });
    await assert.rejects(prepareHostCommand('gh', environment));
    assert.equal(environment.GH_TOKEN, 'private');
  });

  for (const command of ['git', 'gh']) {
    it(`should preserve ${command} arguments, binary streams, and exit status`, async () => {
      await writeFile(
        join(host, command),
        `#!${process.execPath}\nprocess.stderr.write(JSON.stringify(process.argv.slice(2))); process.stdin.pipe(process.stdout); process.stdin.on('end', () => { process.exitCode = 23; });\n`,
        { mode: 0o700 },
      );
      const input = Buffer.alloc(100_000, 0xff);
      const result = spawnSync(
        process.execPath,
        ['--import', tsx, fixture, command, 'a b', '--literal'],
        {
          env: { PATH: host, HOME: root },
          input,
          maxBuffer: 200_000,
        },
      );
      assert.equal(result.status, 23, result.stderr.toString());
      assert.deepEqual(result.stdout, input);
      assert.equal(result.stderr.toString(), '["a b","--literal"]');
    });
  }

  it('should prevent a host descendant from resolving a managed shim alias', async () => {
    const native = join(root, 'native');
    await mkdir(native);
    await writeFile(join(host, 'git'), '#!/bin/sh\nexec gh child\n', { mode: 0o700 });
    await writeFile(join(managed, 'gh'), '#!/bin/sh\nprintf managed\n', { mode: 0o700 });
    await symlink(join(managed, 'gh'), join(host, 'gh'));
    await writeFile(join(native, 'gh'), '#!/bin/sh\nprintf "host:%s" "$1"\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, ['--import', tsx, fixture, 'git'], {
      env: { PATH: [host, native].join(delimiter), AGENT_SYSTEM_TOOL_LAUNCHER_DIR: managed },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'host:child');
  });

  it('should deliver signals to the replaced host process', async () => {
    await writeFile(
      join(host, 'git'),
      `#!${process.execPath}\nprocess.stdout.write('ready'); setInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    );
    const child = spawn(process.execPath, ['--import', tsx, fixture, 'git'], {
      env: { PATH: host },
    });
    try {
      await once(child.stdout, 'data');
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      assert.deepEqual(await exited, [null, 'SIGTERM']);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
