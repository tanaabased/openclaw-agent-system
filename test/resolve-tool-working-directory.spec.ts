import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import resolveToolWorkingDirectory from '../utils/resolve-tool-working-directory.ts';

describe('utils/resolve-tool-working-directory', () => {
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
    const outside = join(root, 'outside');
    await Promise.all([mkdir(nested, { recursive: true }), mkdir(outside)]);
    await symlink(outside, join(workspace, 'escape'));

    assert.equal(await resolveToolWorkingDirectory(workspace, 'project'), await realpath(nested));
    await assert.rejects(resolveToolWorkingDirectory(workspace, 'escape'), /outside/);
  });

  it('should admit one explicit external root without admitting its siblings', async () => {
    const workspace = join(root, 'workspace');
    const admitted = join(root, 'worktrees', 'task');
    const nested = join(admitted, 'src');
    const sibling = join(root, 'worktrees', 'other');
    await Promise.all([workspace, nested, sibling].map((path) => mkdir(path, { recursive: true })));

    assert.equal(
      await resolveToolWorkingDirectory(workspace, nested, [admitted]),
      await realpath(nested),
    );
    await assert.rejects(resolveToolWorkingDirectory(workspace, sibling, [admitted]));
  });
});
