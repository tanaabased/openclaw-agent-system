import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageBin = join(projectDir, 'bin');
const launcher = join(packageBin, 'agent-system-tool');

describe('bin/agent-system-tool', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-tool-launcher-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true });
  });

  it('should delegate any valid tool command through one packaged launcher', async () => {
    const hostBin = join(root, 'host-bin');
    await mkdir(hostBin);
    await writeFile(
      join(hostBin, 'openclaw'),
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), launcherDirectory: process.env.AGENT_SYSTEM_TOOL_LAUNCHER_DIR }));\n',
    );
    await chmod(join(hostBin, 'openclaw'), 0o755);

    const result = spawnSync(launcher, ['future-tool', 'example'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [hostBin, packageBin, process.env.PATH].filter(Boolean).join(delimiter),
      },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      argv: ['agent-system', 'tool', 'future-tool', '--', 'example'],
      launcherDirectory: packageBin,
    });
  });

  it('should reject invalid tool commands before starting openclaw', () => {
    for (const args of [[], ['../git']]) {
      const result = spawnSync(launcher, args, { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /tool command/u);
    }
  });

  it('should stop when its launcher directory cannot be resolved', async () => {
    const hostBin = join(root, 'host-bin');
    const marker = join(root, 'openclaw-ran');
    await mkdir(hostBin);
    await writeFile(join(hostBin, 'openclaw'), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(hostBin, 'openclaw'), 0o755);

    const result = spawnSync(
      '/bin/sh',
      ['-c', '. "$AGENT_SYSTEM_TEST_LAUNCHER"', '/missing/agent-system-tool', 'git', 'status'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_SYSTEM_TEST_LAUNCHER: launcher,
          PATH: [hostBin, process.env.PATH].filter(Boolean).join(delimiter),
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not resolve the tool launcher directory/u);
    await assert.rejects(access(marker));
  });
});
