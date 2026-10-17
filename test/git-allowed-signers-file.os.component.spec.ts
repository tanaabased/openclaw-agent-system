import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import resolveGitAllowedSignersFile from '../tools/git/allowed-signers-file.ts';

describe('tools/git/allowed-signers-file', () => {
  let root = '';
  let workspaceDir = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-git-signers-'));
    workspaceDir = join(root, 'workspace');
    await mkdir(join(workspaceDir, '.agent-system'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('should resolve one regular workspace-contained public trust file', async () => {
    const path = join(workspaceDir, '.agent-system', 'allowed_signers');
    await writeFile(path, 'data@example.com ssh-ed25519 AAAA\n');

    assert.equal(
      resolveGitAllowedSignersFile('.agent-system/allowed_signers', workspaceDir),
      await realpath(path),
    );
  });

  it('should reject absolute, escaping, missing, and symlinked declarations', async () => {
    const target = join(workspaceDir, '.agent-system', 'target');
    const link = join(workspaceDir, '.agent-system', 'allowed_signers');
    await writeFile(target, 'data@example.com ssh-ed25519 AAAA\n');
    await symlink(target, link);

    for (const path of [
      '/tmp/allowed_signers',
      '../allowed_signers',
      'missing',
      '.agent-system/allowed_signers',
    ]) {
      assert.throws(() => resolveGitAllowedSignersFile(path, workspaceDir));
    }
  });
});
