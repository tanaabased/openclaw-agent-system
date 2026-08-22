import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import PathProjectionStore, { type StoredPathProjection } from '../paths/projection-store.ts';

describe('paths/projection-store', () => {
  it('should return no receipt when the store or agent receipt is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));

    assert.equal(await new PathProjectionStore({}).read('data'), undefined);
    assert.equal(await new PathProjectionStore({ rootDir: root }).read('data'), undefined);
  });

  it('should persist and read an agent-owned receipt with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const store = new PathProjectionStore({ currentUid: process.getuid?.(), rootDir: root });
    const state: StoredPathProjection = {
      schemaVersion: 1,
      agentId: 'data',
      workspaceDir: '/workspace/data',
      openClawPaths: ['/workspace/data/bin', '/package/bin'],
    };

    await store.write(state);

    const agentDir = join(root, 'data');
    const receiptPath = join(agentDir, 'path-projection.json');
    assert.deepEqual(await store.read('data'), state);
    assert.equal((await lstat(agentDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
  });

  it('should reject invalid agent ids and unusable stores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const state: StoredPathProjection = {
      schemaVersion: 1,
      agentId: '../data',
      workspaceDir: '/workspace/data',
      openClawPaths: ['/workspace/data/bin'],
    };

    await assert.rejects(
      new PathProjectionStore({ rootDir: root }).write(state),
      /does not have a usable configuration directory/u,
    );
    await assert.rejects(
      new PathProjectionStore({}).write({ ...state, agentId: 'data' }),
      /does not have a usable configuration directory/u,
    );
  });

  it('should reject receipts that do not belong to the requested agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const agentDir = join(root, 'data');
    await mkdir(agentDir, { mode: 0o700 });
    await writeFile(
      join(agentDir, 'path-projection.json'),
      JSON.stringify({
        schemaVersion: 1,
        agentId: 'other',
        workspaceDir: '/workspace/data',
        openClawPaths: ['/workspace/data/bin'],
      }),
    );
    await chmod(join(agentDir, 'path-projection.json'), 0o600);

    await assert.rejects(
      new PathProjectionStore({ rootDir: root }).read('data'),
      /path projection receipt is invalid/u,
    );
  });

  it('should reject non-regular receipt paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const agentDir = join(root, 'data');
    const target = join(root, 'target.json');
    await mkdir(agentDir, { mode: 0o700 });
    await writeFile(target, '{}');
    await symlink(target, join(agentDir, 'path-projection.json'));

    await assert.rejects(
      new PathProjectionStore({ rootDir: root }).read('data'),
      /path projection receipt may not be a symbolic link/u,
    );
  });

  it('should reject public or incorrectly owned receipt state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const store = new PathProjectionStore({ currentUid: process.getuid?.(), rootDir: root });
    const state: StoredPathProjection = {
      schemaVersion: 1,
      agentId: 'data',
      workspaceDir: '/workspace/data',
      openClawPaths: ['/workspace/data/bin'],
    };
    await store.write(state);
    const receiptPath = join(root, 'data', 'path-projection.json');
    await chmod(receiptPath, 0o644);

    await assert.rejects(store.read('data'), /must be private to the current user/u);

    const currentUid = process.getuid?.();
    if (currentUid === undefined) return;
    await chmod(receiptPath, 0o600);
    await assert.rejects(
      new PathProjectionStore({ currentUid: currentUid + 1, rootDir: root }).read('data'),
      /must be owned by the current user/u,
    );
  });

  it('should reject unsafe receipt directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const agentDir = join(root, 'data');
    await mkdir(agentDir, { mode: 0o700 });
    await chmod(agentDir, 0o755);

    await assert.rejects(
      new PathProjectionStore({ rootDir: root }).read('data'),
      /directories must be private/u,
    );
  });

  it('should reject oversized and invalid utf8 receipt state', async () => {
    const oversizedRoot = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const oversizedAgentDir = join(oversizedRoot, 'data');
    await mkdir(oversizedAgentDir, { mode: 0o700 });
    const oversizedPath = join(oversizedAgentDir, 'path-projection.json');
    await writeFile(oversizedPath, Buffer.alloc(64 * 1024 + 1));
    await chmod(oversizedPath, 0o600);

    await assert.rejects(
      new PathProjectionStore({ rootDir: oversizedRoot }).read('data'),
      /exceeds its size limit/u,
    );

    const invalidRoot = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const invalidAgentDir = join(invalidRoot, 'data');
    await mkdir(invalidAgentDir, { mode: 0o700 });
    const invalidPath = join(invalidAgentDir, 'path-projection.json');
    await writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
    await chmod(invalidPath, 0o600);

    await assert.rejects(
      new PathProjectionStore({ rootDir: invalidRoot }).read('data'),
      /path projection receipt is invalid/u,
    );
  });
});
