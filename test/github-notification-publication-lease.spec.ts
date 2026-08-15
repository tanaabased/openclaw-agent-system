import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationPublicationLeaseStore from '../channels/github/lib/publication-lease.ts';

describe('channels/github/lib/publication-lease', () => {
  it('should hold one target-specific host lock beneath private agent state', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-publication-lease-'));
    const rootDir = join(temporaryDirectory, 'state');
    const target = 'same-target';
    const digest = createHash('sha256').update(target).digest('hex');
    const lockPath = join(
      rootDir,
      `tanaabot/channels/github-notification-publications/${digest}.lock`,
    );
    try {
      const store = new GitHubNotificationPublicationLeaseStore({ rootDir });
      const result = await store.exclusive('tanaabot', target, undefined, async () => {
        assert.equal((await lstat(lockPath)).isFile(), true);
        return 'published';
      });

      assert.equal(result, 'published');
      assert.equal((await lstat(rootDir)).mode & 0o077, 0);
      await assert.rejects(lstat(lockPath), /ENOENT/u);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
