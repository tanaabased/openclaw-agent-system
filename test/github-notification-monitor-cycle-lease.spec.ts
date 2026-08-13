import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FILE_LOCK_TIMEOUT_ERROR_CODE } from 'openclaw/plugin-sdk/file-lock';

import GitHubNotificationMonitorCycleLeaseStore from '../channels/github/lib/monitor-cycle-lease.ts';

function lockTimeout(): Error {
  return Object.assign(new Error('busy'), { code: FILE_LOCK_TIMEOUT_ERROR_CODE });
}

describe('channels/github/lib/monitor-cycle-lease', () => {
  it('should acquire the host file lock beneath private agent state', async () => {
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
        (await lstat(join(rootDir, 'tanaabot/channels/github-notifications.lock'))).isFile(),
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

  it('should retry host lock timeouts through the bounded notification wait', async () => {
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

  it('should return busy when the host lock is held and no wait was requested', async () => {
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

  it('should isolate outbound publication from the monitor cycle lock', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-scopes-'));
    const targets: string[] = [];
    try {
      const store = new GitHubNotificationMonitorCycleLeaseStore({
        async acquireFileLock(targetPath) {
          targets.push(targetPath);
          return { lockPath: `${targetPath}.lock`, async release() {} };
        },
        rootDir: join(temporaryDirectory, 'state'),
      });

      const cycle = await store.acquire('tanaabot');
      const publication = await store.acquire('tanaabot', { scope: 'publication' });

      assert.deepEqual(
        targets.map((target) => target.slice(target.lastIndexOf('/') + 1)),
        ['github-notifications', 'github-notifications-publication'],
      );
      if (cycle.status === 'acquired') await cycle.lease.release();
      if (publication.status === 'acquired') await publication.lease.release();
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
