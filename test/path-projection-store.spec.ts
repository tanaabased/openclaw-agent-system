import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import PathProjectionStore, { type StoredPathProjection } from '../paths/projection-store.ts';

describe('paths/projection-store', () => {
  it('should return no receipt when the store or agent receipt is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));

    assert.equal(await new PathProjectionStore(undefined).read('data'), undefined);
    assert.equal(await new PathProjectionStore(root).read('data'), undefined);
  });

  it('should persist and read an agent-owned receipt with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const store = new PathProjectionStore(root);
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
      new PathProjectionStore(root).write(state),
      /does not have a usable configuration directory/u,
    );
    await assert.rejects(
      new PathProjectionStore(undefined).write({ ...state, agentId: 'data' }),
      /does not have a usable configuration directory/u,
    );
  });

  it('should reject receipts that do not belong to the requested agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const agentDir = join(root, 'data');
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, 'path-projection.json'),
      JSON.stringify({
        schemaVersion: 1,
        agentId: 'other',
        workspaceDir: '/workspace/data',
        openClawPaths: ['/workspace/data/bin'],
      }),
    );

    await assert.rejects(
      new PathProjectionStore(root).read('data'),
      /path projection receipt is invalid/u,
    );
  });

  it('should reject non-regular receipt paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    const agentDir = join(root, 'data');
    const target = join(root, 'target.json');
    await mkdir(agentDir);
    await writeFile(target, '{}');
    await symlink(target, join(agentDir, 'path-projection.json'));

    await assert.rejects(
      new PathProjectionStore(root).read('data'),
      /path projection receipt must be a regular file/u,
    );
  });
});
