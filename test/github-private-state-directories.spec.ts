import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ensurePrivateStateDirectories from '../channels/github/utils/ensure-private-state-directories.ts';

describe('channels/github/utils/ensure-private-state-directories', () => {
  it('should create and verify a private state directory chain', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-private-state-'));
    const rootDir = join(temporaryDirectory, 'state');
    const agentDir = join(rootDir, 'tanaabot');
    const channelDir = join(agentDir, 'channels');
    try {
      await ensurePrivateStateDirectories({
        currentUid: process.getuid?.(),
        directories: [rootDir, agentDir, channelDir],
        label: 'GitHub notification state',
      });

      for (const directory of [rootDir, agentDir, channelDir]) {
        assert.equal((await lstat(directory)).mode & 0o077, 0);
      }
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should reject public and symbolic-link state directories', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-private-state-'));
    const publicDirectory = join(temporaryDirectory, 'public');
    const link = join(temporaryDirectory, 'link');
    try {
      await ensurePrivateStateDirectories({
        directories: [publicDirectory],
        label: 'GitHub notification state',
      });
      await chmod(publicDirectory, 0o755);
      await assert.rejects(
        ensurePrivateStateDirectories({
          directories: [publicDirectory],
          label: 'GitHub notification state',
        }),
        /directories must be private/u,
      );

      await symlink(publicDirectory, link);
      await assert.rejects(
        ensurePrivateStateDirectories({
          directories: [link],
          label: 'GitHub notification state',
        }),
        /directories must be real directories/u,
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should reject state directories owned by another user', async () => {
    const currentUid = process.getuid?.();
    if (currentUid === undefined) return;
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-private-state-'));
    try {
      await assert.rejects(
        ensurePrivateStateDirectories({
          currentUid: currentUid + 1,
          directories: [join(temporaryDirectory, 'state')],
          label: 'GitHub notification state',
        }),
        /directories must be owned by the current user/u,
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
