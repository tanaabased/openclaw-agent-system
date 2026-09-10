import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationMonitorStateStore from '../channels/github/intake/monitor/state-store.ts';
import { patchGitHubNotificationItem } from '../channels/github/intake/monitor/state-checkpoint.ts';
import { githubNotificationRetirementItemKeys } from '../channels/github/intake/monitor/state.ts';
import GitHubNotificationMonitorCycleLeaseStore from '../channels/github/intake/monitor/cycle-lease.ts';
import {
  approvedNotificationItem,
  notificationItemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

describe('channels/github/intake/monitor/state-store', () => {
  it('should serialize updates from independent stores without using the execution lease', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-updates-'));
    const rootDir = join(temporaryDirectory, 'state');
    const first = new GitHubNotificationMonitorStateStore({ rootDir });
    const second = new GitHubNotificationMonitorStateStore({ rootDir });
    const cycleStore = new GitHubNotificationMonitorCycleLeaseStore({ rootDir });
    const state = notificationMonitorState();
    const agentId = state.agentId;
    let cycle;
    try {
      await first.write(state);
      cycle = await cycleStore.acquire(agentId);
      assert.equal(cycle.status, 'acquired');
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          (index % 2 ? first : second).update(agentId, (current) => {
            assert.ok(current);
            return { ...current, failureCount: current.failureCount + 1 };
          }),
        ),
      );
      assert.equal((await second.read(agentId))?.failureCount, 8);
      assert.equal((await cycleStore.acquire(agentId)).status, 'busy');
    } finally {
      if (cycle?.status === 'acquired') await cycle.lease.release();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should leave state intact and release the lock after rejected updates', async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'agent-system-monitor-update-failure-'),
    );
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const store = new GitHubNotificationMonitorStateStore({ rootDir });
      const state = notificationMonitorState();
      await store.write(state);
      await assert.rejects(
        store.update(state.agentId, () => {
          throw new Error('controlled checkpoint failure');
        }),
        /controlled checkpoint failure/u,
      );
      await assert.rejects(
        store.update(state.agentId, () => ({ ...state, token: 'invalid' })),
        /state is invalid/u,
      );
      await assert.rejects(
        store.update(state.agentId, () => ({ ...state, agentId: 'other' })),
        /another agent/u,
      );
      assert.deepEqual(await store.read(state.agentId), state);
      const independent = new GitHubNotificationMonitorStateStore({ rootDir });
      await independent.update(state.agentId, (current) =>
        patchGitHubNotificationItem(current, state, notificationItemKey, {
          intake: { stage: 'prepared', worktreeBranch: 'issue-12', worktreePath: '/worktrees/12' },
        }),
      );
      assert.equal(
        (await store.read(state.agentId))?.items[notificationItemKey]?.intake?.stage,
        'prepared',
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('should retain assignments admitted after disabled cleanup inspected the state', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-monitor-remove-'));
    const rootDir = join(temporaryDirectory, 'state');
    try {
      const store = new GitHubNotificationMonitorStateStore({ rootDir });
      const state = notificationMonitorState();
      await store.write({ ...state, items: {} });
      assert.deepEqual(githubNotificationRetirementItemKeys(await store.read(state.agentId)), []);
      const independent = new GitHubNotificationMonitorStateStore({ rootDir });
      await independent.update(state.agentId, () => state);
      assert.equal(
        await store.remove(
          state.agentId,
          (latest) => githubNotificationRetirementItemKeys(latest).length === 0,
        ),
        false,
      );
      assert.deepEqual(await store.read(state.agentId), state);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

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
              lifecycleId: 'pull-request',
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
});
