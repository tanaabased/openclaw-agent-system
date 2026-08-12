import assert from 'node:assert/strict';

import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import GitHubNotificationAssignmentOrchestrator, {
  GitHubNotificationAssignmentOrchestratorError,
} from '../channels/github/lib/assignment-orchestrator.ts';
import {
  notificationItemKey as itemKey,
  notificationMonitorState as monitorState,
} from './github-notification-fixtures.ts';

const worktree = { branch: 'issue-7-branch', path: '/workspace/worktrees/issue-7' };
const activeSession = {
  key: 'agent:tanaabot:agent-system-github:tanaabot:direct:github:item',
  status: 'active' as const,
};

function memoryStore(initial = monitorState()) {
  let state = structuredClone(initial);
  const writes: GitHubNotificationMonitorState[] = [];
  return {
    async read() {
      return structuredClone(state);
    },
    state: () => structuredClone(state),
    async write(next: GitHubNotificationMonitorState) {
      state = structuredClone(next);
      writes.push(structuredClone(next));
    },
    writes,
  };
}

describe('channels/github/lib/assignment-orchestrator', () => {
  it('should serialize duplicate reconciliation around one channel-owned session dispatch', async () => {
    const store = memoryStore();
    let observedWorktree: typeof worktree | undefined;
    let worktreePreparations = 0;
    let briefingDispatches = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        async dispatchBriefing() {
          briefingDispatches += 1;
          return activeSession;
        },
      },
      stateStore: store,
      worktrees: {
        inspect: async () => observedWorktree,
        async prepare() {
          worktreePreparations += 1;
          observedWorktree = worktree;
          return worktree;
        },
      },
    });

    await Promise.all([
      orchestrator.reconcile('tanaabot', itemKey),
      orchestrator.reconcile('tanaabot', itemKey),
    ]);

    assert.equal(worktreePreparations, 1);
    assert.equal(briefingDispatches, 1);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'active');
    assert.deepEqual(
      store.writes.map((state) => state.items[itemKey]?.delivery?.stage),
      ['admitted', 'worktree-ready', 'briefing-running', 'active'],
    );
  });

  it('should not redispatch after an ambiguous channel dispatch failure', async () => {
    const state = monitorState();
    state.items[itemKey]!.delivery = {
      ...state.items[itemKey]!.delivery!,
      stage: 'worktree-ready',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    const store = memoryStore(state);
    let briefingDispatches = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        async dispatchBriefing() {
          briefingDispatches += 1;
          throw new Error('ambiguous provider response');
        },
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await assert.rejects(
      orchestrator.reconcile('tanaabot', itemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationAssignmentOrchestratorError &&
        error.code === 'github-notification-briefing-dispatch-failed',
    );
    await assert.rejects(
      orchestrator.reconcile('tanaabot', itemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationAssignmentOrchestratorError &&
        error.code === 'github-notification-briefing-ambiguous',
    );

    assert.equal(briefingDispatches, 1);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'briefing-running');
    assert.equal(
      store.state().items[itemKey]?.delivery?.failureCode,
      'github-notification-briefing-ambiguous',
    );
  });

  it('should adopt a prepared worktree after its checkpoint write failed', async () => {
    const store = memoryStore();
    let failWorktreeCheckpoint = true;
    let observedWorktree: typeof worktree | undefined;
    let worktreePreparations = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: { dispatchBriefing: async () => activeSession },
      stateStore: {
        read: store.read,
        async write(next) {
          if (failWorktreeCheckpoint && next.items[itemKey]?.delivery?.stage === 'worktree-ready') {
            failWorktreeCheckpoint = false;
            throw new Error('state write failed');
          }
          await store.write(next);
        },
      },
      worktrees: {
        inspect: async () => observedWorktree,
        async prepare() {
          worktreePreparations += 1;
          observedWorktree = worktree;
          return worktree;
        },
      },
    });

    await assert.rejects(orchestrator.reconcile('tanaabot', itemKey));
    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(worktreePreparations, 1);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'active');
  });

  it('should retire locally without trying to manage the openclaw session', async () => {
    const store = memoryStore();
    let briefingDispatches = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => ({ authorized: false, reasonCode: 'item-unassigned' }),
      },
      sessions: {
        async dispatchBriefing() {
          briefingDispatches += 1;
          return activeSession;
        },
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(briefingDispatches, 0);
    assert.equal(store.state().items[itemKey]?.disposition, 'retired');
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'retired');
    assert.equal(store.state().items[itemKey]?.reasonCode, 'item-unassigned');
  });

  it('should recheck authority immediately before dispatch', async () => {
    const state = monitorState();
    state.items[itemKey]!.delivery = {
      ...state.items[itemKey]!.delivery!,
      stage: 'worktree-ready',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    const store = memoryStore(state);
    let inspections = 0;
    let briefingDispatches = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => {
          inspections += 1;
          return inspections === 1
            ? { authorized: true }
            : { authorized: false, reasonCode: 'actor-access-revoked' };
        },
      },
      sessions: {
        async dispatchBriefing() {
          briefingDispatches += 1;
          return activeSession;
        },
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(briefingDispatches, 0);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'retired');
    assert.equal(store.state().items[itemKey]?.reasonCode, 'actor-access-revoked');
  });

  it('should retain a value-free dispatch diagnostic', async () => {
    const state = monitorState();
    state.items[itemKey]!.delivery = {
      ...state.items[itemKey]!.delivery!,
      stage: 'worktree-ready',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    const store = memoryStore(state);
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        async dispatchBriefing() {
          throw new Error('restricted host detail');
        },
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await assert.rejects(
      orchestrator.reconcile('tanaabot', itemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationAssignmentOrchestratorError &&
        error.code === 'github-notification-briefing-dispatch-failed' &&
        error.message === 'The notification briefing could not be dispatched.',
    );
    assert.equal(
      store.state().items[itemKey]?.delivery?.failureCode,
      'github-notification-briefing-dispatch-failed',
    );
  });
});
