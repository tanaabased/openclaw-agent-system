import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { resolveToolExecutable } from '../lib/tool-cli-runner.ts';

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
});
