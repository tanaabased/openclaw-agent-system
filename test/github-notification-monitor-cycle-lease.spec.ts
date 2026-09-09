import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateStateFileLockBusyErrorCode } from '../core/private-state-file-lock.ts';
import GitHubNotificationMonitorCycleLeaseStore from '../channels/github/intake/monitor/cycle-lease.ts';

function lockTimeout(): Error {
  return Object.assign(new Error('busy'), { code: privateStateFileLockBusyErrorCode });
}

describe('channels/github/intake/monitor/cycle-lease', () => {
  it('should acquire the repository file lock beneath private agent state', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-lease-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const store = new GitHubNotificationMonitorCycleLeaseStore({
        currentUid: process.getuid?.(),
        rootDir,
      });

      const result = await store.acquire('tanaabot');

      assert.equal(result.status, 'acquired');
      assert.equal((await lstat(rootDir)).mode & 0o077, 0);
      assert.equal((await lstat(join(rootDir, 'tanaabot/channels'))).mode & 0o077, 0);
      assert.equal(
        (await lstat(join(rootDir, 'tanaabot/channels/github-notifications.lock'))).isDirectory(),
        true,
      );
      if (result.status !== 'acquired') assert.fail('expected acquired lease');
      await result.lease.release();
      await assert.rejects(
        lstat(join(rootDir, 'tanaabot/channels/github-notifications.lock')),
        /ENOENT/u,
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should exclude independent stores through one atomic filesystem lease', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-exclusive-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const firstStore = new GitHubNotificationMonitorCycleLeaseStore({ rootDir });
      const secondStore = new GitHubNotificationMonitorCycleLeaseStore({ rootDir });
      const first = await firstStore.acquire('tanaabot');

      assert.equal(first.status, 'acquired');
      assert.equal((await secondStore.acquire('tanaabot')).status, 'busy');
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

  it('should retry lock contention through the bounded notification wait', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-retry-'));
    const rootDir = join(temporaryDirectory, 'state');
    let attempts = 0;
    try {
      const store = new GitHubNotificationMonitorCycleLeaseStore({
        async acquireFileLock(targetPath, options) {
          attempts += 1;
          assert.equal(targetPath, join(rootDir, 'tanaabot/channels/github-notifications'));
          assert.equal(options.retries.retries, 0);
          if (attempts === 1) throw lockTimeout();
          return {
            lockPath: `${targetPath}.lock`,
            async release() {},
          };
        },
        retryMs: 1,
        rootDir,
      });

      const result = await store.acquire('tanaabot', { waitMs: 100 });

      assert.equal(result.status, 'acquired');
      assert.equal(attempts, 2);
      if (result.status !== 'acquired') assert.fail('expected acquired lease');
      await result.lease.release();
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should return busy when the repository lock is held and no wait was requested', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-busy-'));
    try {
      const store = new GitHubNotificationMonitorCycleLeaseStore({
        async acquireFileLock() {
          throw lockTimeout();
        },
        rootDir: join(temporaryDirectory, 'state'),
      });

      assert.equal((await store.acquire('tanaabot')).status, 'busy');
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should stop a bounded wait when notification processing is aborted', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-abort-'));
    try {
      const store = new GitHubNotificationMonitorCycleLeaseStore({
        async acquireFileLock() {
          throw lockTimeout();
        },
        retryMs: 5,
        rootDir: join(temporaryDirectory, 'state'),
      });
      const controller = new AbortController();
      const waiting = store.acquire('tanaabot', { signal: controller.signal, waitMs: 10_000 });
      controller.abort();

      assert.equal((await waiting).status, 'aborted');
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
