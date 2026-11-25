import sqliteAgentFixture from './sqlite-agent-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import PathProjectionStore, { type StoredPathProjection } from '../paths/projection-store.ts';

describe('paths/projection-store', () => {
  it('should preserve the owned path prefix across a failed save and a workspace move', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-store-'));
    try {
      const db = await sqliteAgentFixture(root, 'data');
      const store = new PathProjectionStore(db.sqliteInstallation);
      const state: StoredPathProjection = {
        schemaVersion: 1,
        agentId: 'data',
        workspaceDir: '/old',
        openClawPaths: ['/old/bin'],
      };
      assert.equal(await store.read('data'), undefined);
      await store.write(state);
      await assert.rejects(
        store.write({ ...state, openClawPaths: ['a'.repeat(64 * 1024)] }),
        /exceeds its size limit/,
      );
      assert.deepEqual(await store.read('data', '/old'), state);
      const moved = { ...state, workspaceDir: '/new', openClawPaths: ['/new/bin'] };
      await store.write(moved);
      assert.equal(await store.read('data', '/old'), undefined);
      assert.deepEqual(
        await new PathProjectionStore(db.sqliteInstallation).read('data', '/new'),
        moved,
      );
      await db.agent.replacePathProjection({ ...moved, agentId: 'another' });
      await assert.rejects(store.read('data'), /receipt is invalid/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
