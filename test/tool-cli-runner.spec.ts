import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import runToolCli, { resolveToolExecutable } from '../lib/tool-cli-runner.ts';

describe('lib/tool-cli-runner', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-runner-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true });
  });

  it('should skip workspace command overrides and resolve the next real executable', async () => {
    const workspaceBin = join(root, 'workspace-bin');
    const systemBin = join(root, 'system-bin');
    await mkdir(workspaceBin);
    await mkdir(systemBin);
    await writeFile(join(workspaceBin, 'gh'), '#!/bin/sh\n');
    await writeFile(join(systemBin, 'gh'), '#!/bin/sh\n');
    await chmod(join(workspaceBin, 'gh'), 0o755);
    await chmod(join(systemBin, 'gh'), 0o755);

    const executable = await resolveToolExecutable(
      'gh',
      [workspaceBin, systemBin].join(delimiter),
      [workspaceBin],
    );

    assert.equal(executable, await realpath(join(systemBin, 'gh')));
  });

  it('should follow external executable symlinks without permitting a workspace command bypass', async () => {
    const bin = join(root, 'bin');
    const workspaceBin = join(root, 'workspace-bin');
    await mkdir(bin);
    await mkdir(workspaceBin);
    await symlink('/usr/bin/true', join(bin, 'gh'));
    await symlink('/usr/bin/false', join(workspaceBin, 'gh'));

    assert.equal(await resolveToolExecutable('gh', bin), await realpath('/usr/bin/true'));
    assert.equal(
      await resolveToolExecutable('gh', [workspaceBin, bin].join(delimiter), [workspaceBin]),
      await realpath('/usr/bin/true'),
    );
  });

  it('should report the executable selected for the child process', async () => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'probe'), '#!/bin/sh\nprintf selected');
    await chmod(join(bin, 'probe'), 0o755);

    const result = await runToolCli({
      argv: [],
      cwd: root,
      environment: { PATH: bin },
      executable: 'probe',
      maxOutputBytes: 1024,
      timeoutMs: 1000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.resolvedExecutable, await realpath(join(bin, 'probe')));
    assert.equal(result.stdout, 'selected');
  });

  it('should bound combined standard output and error capture', async () => {
    const script = join(root, 'output.mjs');
    await writeFile(script, "process.stdout.write('abc');\nprocess.stderr.write('def');\n");

    const result = await runToolCli({
      argv: [script],
      cwd: root,
      environment: process.env,
      executable: process.execPath,
      maxOutputBytes: 4,
      timeoutMs: 1000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 4);
    assert.equal(result.truncated, true);
  });

  it('should terminate a child process after its timeout', async () => {
    const script = join(root, 'timeout.mjs');
    await writeFile(script, 'setInterval(() => {}, 1000);\n');

    const result = await runToolCli({
      argv: [script],
      cwd: root,
      environment: process.env,
      executable: process.execPath,
      maxOutputBytes: 1024,
      timeoutMs: 20,
    });

    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, true);
  });

  it('should terminate immediately when the request is already aborted', async () => {
    const script = join(root, 'abort.mjs');
    await writeFile(script, 'setInterval(() => {}, 1000);\n');
    const controller = new AbortController();
    controller.abort();

    const result = await runToolCli({
      argv: [script],
      cwd: root,
      environment: process.env,
      executable: process.execPath,
      maxOutputBytes: 1024,
      signal: controller.signal,
      timeoutMs: 1000,
    });

    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
  });
});
