import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageBin = join(projectDir, 'bin');
const command = join(packageBin, 'git');

describe('bin/git', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-git-command-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true });
  });

  it('should identify itself and delegate arguments without rewriting them', async () => {
    const probe = spawnSync(command, ['--agent-system'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: [packageBin, process.env.PATH].filter(Boolean).join(delimiter) },
    });
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, 'agent-system\n');

    const hostBin = join(root, 'host-bin');
    await mkdir(hostBin);
    await writeFile(
      join(hostBin, 'openclaw'),
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), launcherDirectory: process.env.AGENT_SYSTEM_TOOL_LAUNCHER_DIR }));\n',
    );
    await chmod(join(hostBin, 'openclaw'), 0o755);
    const delegated = spawnSync(command, ['status', '--short'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [hostBin, packageBin, process.env.PATH].filter(Boolean).join(delimiter),
      },
    });
    assert.equal(delegated.status, 0);
    assert.deepEqual(JSON.parse(delegated.stdout), {
      argv: ['agent-system', 'tool', 'git', '--', 'status', '--short'],
      launcherDirectory: packageBin,
    });
  });
});
