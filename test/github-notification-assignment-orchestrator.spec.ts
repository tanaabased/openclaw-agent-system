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
        retire: async () => ({ ...activeSession, status: 'retired' }),
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
        retire: async () => ({ ...activeSession, status: 'retired' }),
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
        retire: async () => ({ ...activeSession, status: 'retired' }),
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

  it('should adopt a prepared session after its checkpoint write failed', async () => {
    const store = memoryStore();
    let failSessionCheckpoint = true;
    let observedSession: typeof readySession | typeof activeSession | undefined;
    let sessionPreparations = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        async dispatchBriefing() {
          observedSession = activeSession;
          return activeSession;
        },
        inspect: async () => observedSession,
        async prepare() {
          sessionPreparations += 1;
          observedSession = readySession;
          return readySession;
        },
        retire: async () => ({ ...activeSession, status: 'retired' }),
      },
      stateStore: {
        read: store.read,
        async write(next) {
          if (failSessionCheckpoint && next.items[itemKey]?.delivery?.stage === 'session-ready') {
            failSessionCheckpoint = false;
            throw new Error('state write failed');
          }
          await store.write(next);
        },
      },
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await assert.rejects(orchestrator.reconcile('tanaabot', itemKey));
    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(sessionPreparations, 1);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'active');
  });

  it('should diagnose an incomplete claimed briefing without dispatching it again', async () => {
    const initial = monitorState();
    const delivery = initial.items[itemKey]?.delivery;
    assert.ok(delivery);
    initial.items[itemKey]!.delivery = {
      ...delivery,
      sessionKey: readySession.key,
      stage: 'briefing-running',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    const store = memoryStore(initial);
    let dispatches = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        async dispatchBriefing() {
          dispatches += 1;
          return activeSession;
        },
        inspect: async () => ({ key: readySession.key, status: 'incomplete' }),
        prepare: async () => readySession,
        retire: async () => ({ ...activeSession, status: 'retired' }),
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await assert.rejects(
      orchestrator.reconcile('tanaabot', itemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationAssignmentOrchestratorError &&
        error.code === 'github-notification-briefing-incomplete',
    );

    assert.equal(dispatches, 0);
    assert.equal(
      store.state().items[itemKey]?.delivery?.failureCode,
      'github-notification-briefing-incomplete',
    );
  });

  it('should abort and archive an existing session before completing retirement', async () => {
    const store = memoryStore();
    let observedSession: typeof activeSession | { id: string; key: string; status: 'retired' } =
      activeSession;
    let sessionRetirements = 0;
    let forbiddenSideEffects = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => ({ authorized: false, reasonCode: 'item-unassigned' }),
      },
      sessions: {
        async dispatchBriefing() {
          forbiddenSideEffects += 1;
          return activeSession;
        },
        inspect: async () => observedSession,
        async prepare() {
          forbiddenSideEffects += 1;
          return readySession;
        },
        async retire() {
          sessionRetirements += 1;
          observedSession = { ...activeSession, status: 'retired' };
          return observedSession;
        },
      },
      stateStore: store,
      worktrees: {
        inspect: async () => worktree,
        async prepare() {
          forbiddenSideEffects += 1;
          return worktree;
        },
      },
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(forbiddenSideEffects, 0);
    assert.equal(sessionRetirements, 1);
    assert.equal(store.state().items[itemKey]?.disposition, 'retired');
    assert.equal(store.state().items[itemKey]?.reasonCode, 'item-unassigned');
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'retired');
  });

  it('should resume retirement after the session archive boundary fails', async () => {
    const store = memoryStore();
    let observedSession:
      typeof activeSession | { id: string; key: string; status: 'retired' | 'retiring' } =
      activeSession;
    let retirementAttempts = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => ({ authorized: false, reasonCode: 'item-unassigned' }),
      },
      sessions: {
        dispatchBriefing: async () => activeSession,
        inspect: async () => observedSession,
        prepare: async () => readySession,
        async retire() {
          retirementAttempts += 1;
          if (retirementAttempts === 1) {
            observedSession = { ...activeSession, status: 'retiring' };
            throw new Error('session archive interrupted');
          }
          observedSession = { ...activeSession, status: 'retired' };
          return observedSession;
        },
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await assert.rejects(orchestrator.reconcile('tanaabot', itemKey));
    assert.equal(store.state().items[itemKey]?.disposition, 'retired');
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'admitted');

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(retirementAttempts, 2);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'retired');
  });
});
