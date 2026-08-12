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
  it('should serialize duplicate reconciliation around one channel-owned session record', async () => {
    const store = memoryStore();
    let observedWorktree: typeof worktree | undefined;
    let worktreePreparations = 0;
    let sessionRecords = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        async recordSession() {
          sessionRecords += 1;
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
    assert.equal(sessionRecords, 1);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'active');
    assert.deepEqual(
      store.writes.map((state) => state.items[itemKey]?.delivery?.stage),
      ['admitted', 'worktree-ready', 'session-recording', 'active'],
    );
  });

  it('should retry an idempotent session record after an interrupted attempt', async () => {
    const state = monitorState();
    state.items[itemKey]!.delivery = {
      ...state.items[itemKey]!.delivery!,
      stage: 'worktree-ready',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    const store = memoryStore(state);
    let sessionRecords = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      sessions: {
        async recordSession() {
          sessionRecords += 1;
          if (sessionRecords === 1) throw new Error('interrupted session record');
          return activeSession;
        },
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await assert.rejects(
      orchestrator.reconcile('tanaabot', itemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationAssignmentOrchestratorError &&
        error.code === 'github-notification-session-recording-failed',
    );
    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(sessionRecords, 2);
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
      sessions: { recordSession: async () => activeSession },
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
    let sessionRecords = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => ({ authorized: false, reasonCode: 'item-unassigned' }),
      },
      sessions: {
        async recordSession() {
          sessionRecords += 1;
          return activeSession;
        },
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(sessionRecords, 0);
    assert.equal(store.state().items[itemKey]?.disposition, 'retired');
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'retired');
    assert.equal(store.state().items[itemKey]?.reasonCode, 'item-unassigned');
  });

  it('should recheck authority immediately before recording the session', async () => {
    const state = monitorState();
    state.items[itemKey]!.delivery = {
      ...state.items[itemKey]!.delivery!,
      stage: 'worktree-ready',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    const store = memoryStore(state);
    let inspections = 0;
    let sessionRecords = 0;
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
        async recordSession() {
          sessionRecords += 1;
          return activeSession;
        },
      },
      stateStore: store,
      worktrees: { inspect: async () => worktree, prepare: async () => worktree },
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(sessionRecords, 0);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'retired');
    assert.equal(store.state().items[itemKey]?.reasonCode, 'actor-access-revoked');
  });

  it('should retain a value-free session-recording diagnostic', async () => {
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
        async recordSession() {
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
        error.code === 'github-notification-session-recording-failed' &&
        error.message === 'The notification session could not be recorded.',
    );
    assert.equal(
      store.state().items[itemKey]?.delivery?.failureCode,
      'github-notification-session-recording-failed',
    );
  });

  it('should classify value-free pre-record boundary failures', async () => {
    const scenarios = [
      {
        code: 'github-notification-authority-inspection-failed',
        create(store: ReturnType<typeof memoryStore>) {
          return new GitHubNotificationAssignmentOrchestrator({
            authority: {
              inspect: async () => {
                throw new Error('restricted authority detail');
              },
            },
            sessions: { recordSession: async () => activeSession },
            stateStore: store,
            worktrees: { inspect: async () => worktree, prepare: async () => worktree },
          });
        },
        persisted: true,
      },
      {
        code: 'github-notification-worktree-inspection-failed',
        create(store: ReturnType<typeof memoryStore>) {
          return new GitHubNotificationAssignmentOrchestrator({
            authority: { inspect: async () => ({ authorized: true }) },
            sessions: { recordSession: async () => activeSession },
            stateStore: store,
            worktrees: {
              inspect: async () => {
                throw new Error('restricted inspection detail');
              },
              prepare: async () => worktree,
            },
          });
        },
        persisted: true,
      },
      {
        code: 'github-notification-worktree-preparation-failed',
        create(store: ReturnType<typeof memoryStore>) {
          return new GitHubNotificationAssignmentOrchestrator({
            authority: { inspect: async () => ({ authorized: true }) },
            sessions: { recordSession: async () => activeSession },
            stateStore: store,
            worktrees: {
              inspect: async () => undefined,
              prepare: async () => {
                throw new Error('restricted preparation detail');
              },
            },
          });
        },
        persisted: true,
      },
      {
        code: 'github-notification-state-checkpoint-failed',
        create(store: ReturnType<typeof memoryStore>) {
          return new GitHubNotificationAssignmentOrchestrator({
            authority: { inspect: async () => ({ authorized: true }) },
            sessions: { recordSession: async () => activeSession },
            stateStore: {
              read: store.read,
              write: async () => {
                throw new Error('restricted checkpoint detail');
              },
            },
            worktrees: { inspect: async () => undefined, prepare: async () => worktree },
          });
        },
        persisted: false,
      },
      {
        code: 'github-notification-state-read-failed',
        create(store: ReturnType<typeof memoryStore>) {
          return new GitHubNotificationAssignmentOrchestrator({
            authority: { inspect: async () => ({ authorized: true }) },
            sessions: { recordSession: async () => activeSession },
            stateStore: {
              read: async () => {
                throw new Error('restricted state detail');
              },
              write: store.write,
            },
            worktrees: { inspect: async () => worktree, prepare: async () => worktree },
          });
        },
        persisted: false,
      },
    ];

    for (const scenario of scenarios) {
      const store = memoryStore();
      await assert.rejects(
        scenario.create(store).reconcile('tanaabot', itemKey),
        (error: unknown) =>
          error instanceof GitHubNotificationAssignmentOrchestratorError &&
          error.code === scenario.code &&
          !error.message.includes('restricted'),
      );
      assert.equal(
        store.state().items[itemKey]?.delivery?.failureCode,
        scenario.persisted ? scenario.code : undefined,
      );
    }
  });
});
