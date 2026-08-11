import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationMonitorStateStore from '../channels/github/lib/monitor-state-store.ts';
import { createGitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';

describe('channels/github/lib/monitor-state-store', () => {
  it('should atomically persist private value-free state', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-state-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const store = new GitHubNotificationMonitorStateStore({
        currentUid: process.getuid?.(),
        rootDir,
      });
      const state = createGitHubNotificationMonitorState('tanaabot', '/workspace');
      state.accountLogin = 'tanaabot';
      state.accountNodeId = 'U_tanaabot';
      state.baselineAt = 1;
      await store.write(state);

      assert.deepEqual(await store.read('tanaabot'), state);
      assert.equal((await lstat(rootDir)).mode & 0o077, 0);
      assert.equal(
        (await lstat(join(rootDir, 'tanaabot/channels/github-notifications.json'))).mode & 0o077,
        0,
      );
      await assert.rejects(
        store.write({ ...state, token: 'must-not-persist' } as never),
        /state is invalid/u,
      );
      assert.equal(await store.remove('tanaabot'), true);
      assert.equal(await store.read('tanaabot'), undefined);
      assert.equal(await store.remove('tanaabot'), false);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should reject a symbolic-link state file', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-link-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const store = new GitHubNotificationMonitorStateStore({ rootDir });
      await store.write(createGitHubNotificationMonitorState('tanaabot', '/workspace'));
      const statePath = join(rootDir, 'tanaabot/channels/github-notifications.json');
      await rm(statePath);
      await symlink('/etc/passwd', statePath);
      await assert.rejects(store.read('tanaabot'), /symbolic link/u);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
