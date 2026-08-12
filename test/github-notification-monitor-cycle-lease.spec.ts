import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationMonitorCycleLeaseStore from '../channels/github/lib/monitor-cycle-lease.ts';

describe('channels/github/lib/monitor-cycle-lease', () => {
  it('should serialize separate notification monitor processes per agent', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-lease-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const firstStore = new GitHubNotificationMonitorCycleLeaseStore({
        currentUid: process.getuid?.(),
        rootDir,
      });
      const secondStore = new GitHubNotificationMonitorCycleLeaseStore({
        currentUid: process.getuid?.(),
        rootDir,
      });

      const first = await firstStore.acquire('tanaabot');
      const busy = await secondStore.acquire('tanaabot');

      assert.equal(first.status, 'acquired');
      assert.equal(busy.status, 'busy');
      assert.equal(
        (await lstat(join(rootDir, 'tanaabot/channels/github-notifications.lock'))).mode & 0o077,
        0,
      );
      if (first.status !== 'acquired') assert.fail('expected acquired lease');
      await first.lease.release();
      const second = await secondStore.acquire('tanaabot');
      assert.equal(second.status, 'acquired');
      if (second.status !== 'acquired') assert.fail('expected acquired lease');
      await second.lease.release();
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should recover a lease whose owning process is no longer alive', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-stale-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const firstStore = new GitHubNotificationMonitorCycleLeaseStore({ rootDir });
      const first = await firstStore.acquire('tanaabot');
      assert.equal(first.status, 'acquired');
      const recoveringStore = new GitHubNotificationMonitorCycleLeaseStore({
        isProcessAlive: () => false,
        rootDir,
      });

      const recovered = await recoveringStore.acquire('tanaabot');

      assert.equal(recovered.status, 'acquired');
      if (first.status !== 'acquired' || recovered.status !== 'acquired') {
        assert.fail('expected acquired leases');
      }
      await first.lease.release();
      assert.equal(
        (await lstat(join(rootDir, 'tanaabot/channels/github-notifications.lock'))).isFile(),
        true,
      );
      await recovered.lease.release();
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should stop a bounded wait when notification processing is aborted', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-abort-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const store = new GitHubNotificationMonitorCycleLeaseStore({ retryMs: 5, rootDir });
      const first = await store.acquire('tanaabot');
      assert.equal(first.status, 'acquired');
      const controller = new AbortController();
      const waiting = store.acquire('tanaabot', { signal: controller.signal, waitMs: 10_000 });
      controller.abort();

      assert.equal((await waiting).status, 'aborted');
      if (first.status !== 'acquired') assert.fail('expected acquired lease');
      await first.lease.release();
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
