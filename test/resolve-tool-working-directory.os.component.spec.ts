import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import resolveToolWorkingDirectory from '../api/resolve-working-directory.ts';

describe('api/resolve-working-directory', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-tool-cwd-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true });
  });

  it('should allow nested directories and reject symlink traversal', async () => {
    const workspace = join(root, 'workspace');
    const nested = join(workspace, 'project');
    const missing = join(root, 'missing');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(outside)]);
    await symlink(outside, join(workspace, 'escape'));

    assert.equal(
      await resolveToolWorkingDirectory(workspace, 'project', [missing]),
      await realpath(nested),
    );
    await assert.rejects(resolveToolWorkingDirectory(workspace, 'escape', [missing]), /outside/);
  });

  it('should admit one available external root without requiring every root', async () => {
    const workspace = join(root, 'workspace');
    const admitted = join(root, 'worktrees', 'task');
    const nested = join(admitted, 'src');
    const missing = join(root, 'worktrees', 'missing');
    const sibling = join(root, 'worktrees', 'other');
    await Promise.all([workspace, nested, sibling].map((path) => mkdir(path, { recursive: true })));

    assert.equal(
      await resolveToolWorkingDirectory(workspace, nested, [missing, admitted]),
      await realpath(nested),
    );
    await assert.rejects(resolveToolWorkingDirectory(workspace, sibling, [missing, admitted]));
    await assert.rejects(resolveToolWorkingDirectory(workspace, join(missing, 'src'), [missing]));
  });
});
