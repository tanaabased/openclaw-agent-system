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
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), launcherDirectory: process.env.AGENT_SYSTEM_TOOL_LAUNCHER_DIR }));\n',
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
    const output = JSON.parse(result.stdout) as {
      argv: string[];
      launcherDirectory: string;
    };
    assert.deepEqual(output.argv, ['agent-system', 'tool', 'gh', '--', 'api', 'user']);
    assert.equal(output.launcherDirectory, packageBin);
  });

  it('should preserve redirected standard input for openclaw', async () => {
    const hostBin = join(root, 'host-bin');
    await mkdir(hostBin);
    await writeFile(
      join(hostBin, 'openclaw'),
      "#!/usr/bin/env node\nconst { text } = require('node:stream/consumers');\ntext(process.stdin).then((input) => process.stdout.write(input));\n",
    );
    await chmod(join(hostBin, 'openclaw'), 0o755);

    const result = spawnSync(command, ['api', '/repos/owner/repo/issues', '--input', '-'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [hostBin, packageBin, process.env.PATH].filter(Boolean).join(delimiter),
      },
      input: '{"title":"test"}\n',
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '{"title":"test"}\n');
    assert.equal(result.stderr, '');
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
