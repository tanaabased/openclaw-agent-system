import assert from 'node:assert/strict';

import GitHubNotificationAssignmentOrchestrator, {
  GitHubNotificationAssignmentOrchestratorError,
} from '../lib/github-notification-assignment-orchestrator.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import {
  notificationItemKey as itemKey,
  notificationMonitorState as monitorState,
} from './github-notification-fixtures.ts';

const worktree = { branch: 'issue-7-branch', path: '/workspace/worktrees/issue-7' };
const readySession = { key: 'agent:tanaabot:github:item', status: 'ready' as const };
const activeSession = {
  id: 'session-id',
  key: readySession.key,
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

describe('lib/github-notification-assignment-orchestrator', () => {
  it('should serialize duplicate reconciliation and checkpoint every mutation boundary', async () => {
    const store = memoryStore();
    let observedWorktree: typeof worktree | undefined;
    let observedSession: typeof readySession | typeof activeSession | undefined;
    let worktreePreparations = 0;
    let sessionPreparations = 0;
    let briefingDispatches = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        async dispatchBriefing() {
          briefingDispatches += 1;
          observedSession = activeSession;
          return activeSession;
        },
        inspect: async () => observedSession,
        async prepare() {
          sessionPreparations += 1;
          observedSession = readySession;
          return readySession;
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
    assert.equal(sessionPreparations, 1);
    assert.equal(briefingDispatches, 1);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'active');
    assert.deepEqual(
      store.writes.map((state) => state.items[itemKey]?.delivery?.stage),
      [
        'admitted',
        'worktree-ready',
        'worktree-ready',
        'session-ready',
        'briefing-running',
        'active',
      ],
    );
  });

  it('should reconcile an ambiguous briefing failure before deciding whether to retry', async () => {
    const store = memoryStore();
    let observedSession: typeof readySession | typeof activeSession = readySession;
    let briefingDispatches = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        async dispatchBriefing() {
          briefingDispatches += 1;
          observedSession = activeSession;
          throw new Error('ambiguous provider response');
        },
        inspect: async () => observedSession,
        prepare: async () => readySession,
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await assert.rejects(
      orchestrator.reconcile('tanaabot', itemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationAssignmentOrchestratorError &&
        error.code === 'github-notification-delivery-failed',
    );
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'briefing-running');
    assert.equal(
      store.state().items[itemKey]?.delivery?.failureCode,
      'github-notification-delivery-failed',
    );

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(briefingDispatches, 1);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'active');
    assert.equal(store.state().items[itemKey]?.delivery?.failureCode, undefined);
  });

  it('should adopt a prepared worktree after its checkpoint write failed', async () => {
    const store = memoryStore();
    let failWorktreeCheckpoint = true;
    let observedWorktree: typeof worktree | undefined;
    let worktreePreparations = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        dispatchBriefing: async () => activeSession,
        inspect: async () => activeSession,
        prepare: async () => readySession,
      },
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

  it('should retire without local side effects when fresh authority is revoked', async () => {
    const store = memoryStore();
    let sideEffects = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => ({ authorized: false, reasonCode: 'item-unassigned' }),
      },
      sessions: {
        async dispatchBriefing() {
          sideEffects += 1;
          return activeSession;
        },
        inspect: async () => undefined,
        async prepare() {
          sideEffects += 1;
          return readySession;
        },
      },
      stateStore: store,
      worktrees: {
        inspect: async () => undefined,
        async prepare() {
          sideEffects += 1;
          return worktree;
        },
      },
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(sideEffects, 0);
    assert.equal(store.state().items[itemKey]?.disposition, 'retired');
    assert.equal(store.state().items[itemKey]?.reasonCode, 'item-unassigned');
  });
});
