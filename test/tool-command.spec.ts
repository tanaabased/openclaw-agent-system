import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageBin = join(projectDir, 'bin');
const command = join(packageBin, 'gh');

describe('bin/gh', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-command-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true });
  });

  it('should identify itself without starting openclaw', () => {
    const result = spawnSync(command, ['--agent-system'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: [packageBin, process.env.PATH].filter(Boolean).join(delimiter) },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'agent-system\n');
    assert.equal(result.stderr, '');
  });

  it('should delegate arguments to openclaw without rewriting them', async () => {
    const hostBin = join(root, 'host-bin');
    await mkdir(hostBin);
    await writeFile(
      join(hostBin, 'openclaw'),
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    await chmod(join(hostBin, 'openclaw'), 0o755);

    const result = spawnSync(command, ['api', 'user'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [hostBin, packageBin, process.env.PATH].filter(Boolean).join(delimiter),
      },
    });

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      'agent-system',
      'tool',
      'gh',
      '--',
      'api',
      'user',
    ]);
  });

  it('should preserve a delegated command failure', async () => {
    const hostBin = join(root, 'host-bin');
    await mkdir(hostBin);
    await writeFile(join(hostBin, 'openclaw'), '#!/usr/bin/env node\nprocess.exit(23);\n');
    await chmod(join(hostBin, 'openclaw'), 0o755);

    const result = spawnSync(command, ['api', 'user'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [packageBin, hostBin, process.env.PATH].filter(Boolean).join(delimiter),
      },
    });

    assert.equal(result.status, 23);
  });
});
