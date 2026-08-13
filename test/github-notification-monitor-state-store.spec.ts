import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationMonitorStateStore from '../channels/github/lib/monitor-state-store.ts';
import {
  approvedNotificationItem,
  legacyNotificationMonitorState,
  notificationItemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

describe('channels/github/lib/monitor-state-store', () => {
  it('should atomically persist private value-free state', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-state-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const store = new GitHubNotificationMonitorStateStore({
        currentUid: process.getuid?.(),
        rootDir,
      });
      const state = notificationMonitorState();
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
      await assert.rejects(
        store.write({
          ...state,
          items: {
            ...state.items,
            [notificationItemKey]: {
              ...approvedNotificationItem(),
              delivery: { ...approvedNotificationItem().delivery!, workId: 'issue-8' },
            },
          },
        }),
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
      await store.write(notificationMonitorState());
      const statePath = join(rootDir, 'tanaabot/channels/github-notifications.json');
      await rm(statePath);
      await symlink('/etc/passwd', statePath);
      await assert.rejects(store.read('tanaabot'), /symbolic link/u);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should explicitly migrate phase one state to a diagnosed safe baseline', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-migration-'));
    const rootDir = join(temporaryDirectory, 'state');
    const stateDirectory = join(rootDir, 'tanaabot/channels');
    try {
      await mkdir(stateDirectory, { mode: 0o700, recursive: true });
      await writeFile(
        join(stateDirectory, 'github-notifications.json'),
        `${JSON.stringify({
          ...legacyNotificationMonitorState(),
          baselineItemNodeIds: ['I_baseline'],
        })}\n`,
        { mode: 0o600 },
      );
      const store = new GitHubNotificationMonitorStateStore({
        currentUid: process.getuid?.(),
        rootDir,
      });

      const migrated = await store.load('tanaabot');

      if (migrated.status === 'missing') assert.fail('expected migrated state');
      assert.equal(migrated.status, 'migrated-v1');
      assert.equal(migrated.state.schemaVersion, 2);
      assert.deepEqual(migrated.state.baselineItemNodeIds, ['I_baseline', 'I_item']);
      assert.deepEqual(migrated.state.items, {});
      assert.equal(migrated.state.diagnosticCode, 'github-notification-state-migrated-v1');
      await store.write(migrated.state);
      assert.equal((await store.load('tanaabot')).status, 'ready');
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
