import assert from 'node:assert/strict';

import GitHubNotificationAssignmentOrchestrator, {
  GitHubNotificationAssignmentOrchestratorError,
} from '../channels/github/intake/assignment-orchestrator.ts';
import GitHubIssueLifecycle, {
  type GitHubIssueLifecycleWorktreeService,
} from '../channels/github/lifecycles/issue.ts';
import GitHubPullRequestLifecycle from '../channels/github/lifecycles/pull-request.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/intake/monitor/state.ts';
import {
  approvedPullRequestNotificationItem,
  notificationItemKey as itemKey,
  notificationMonitorState as monitorState,
  notificationPullRequestItemKey,
} from './github-notification-fixtures.ts';

const worktree = { branch: 'issue-7-branch', path: '/workspace/worktrees/issue-7' };

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

function lifecycles(worktrees: {
  inspect: GitHubIssueLifecycleWorktreeService['inspectGitHub'];
  prepare: GitHubIssueLifecycleWorktreeService['prepareGitHub'];
}) {
  return new GitHubNotificationLifecycleRegistry([
    new GitHubIssueLifecycle({
      inspectGitHub: worktrees.inspect,
      prepareGitHub: worktrees.prepare,
    }),
    new GitHubPullRequestLifecycle(),
  ]);
}

describe('channels/github/intake/assignment-orchestrator', () => {
  it('should prepare one issue worktree and assignment turn', async () => {
    const store = memoryStore();
    let observedWorktree: typeof worktree | undefined;
    let sessionPreparations = 0;
    let worktreePreparations = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({
        inspect: async () => observedWorktree,
        async prepare() {
          worktreePreparations += 1;
          observedWorktree = worktree;
          return worktree;
        },
      }),
      sessions: {
        async prepare(input) {
          sessionPreparations += 1;
          assert.equal(input.executionSurface, 'gateway');
          assert.deepEqual(input.worktree, worktree);
        },
      },
      stateStore: store,
    });

    await Promise.all([
      orchestrator.reconcile('tanaabot', itemKey),
      orchestrator.reconcile('tanaabot', itemKey),
    ]);

    const intake = store.state().items[itemKey]?.intake;
    assert.equal(worktreePreparations, 1);
    assert.equal(sessionPreparations, 1);
    assert.equal(intake?.stage, 'prepared');
    assert.deepEqual(
      store.writes.map((state) => state.items[itemKey]?.intake?.stage),
      ['prepared'],
    );
  });

  it('should complete pull-request intake without a worktree', async () => {
    const state = monitorState();
    state.items = {
      [notificationPullRequestItemKey]: approvedPullRequestNotificationItem(),
    };
    const store = memoryStore(state);
    let worktreeInspections = 0;
    let worktreePreparations = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({
        async inspect() {
          worktreeInspections += 1;
          return undefined;
        },
        async prepare() {
          worktreePreparations += 1;
          return worktree;
        },
      }),
      sessions: { prepare: async () => undefined },
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', notificationPullRequestItemKey);

    const intake = store.state().items[notificationPullRequestItemKey]?.intake;
    assert.equal(worktreeInspections, 0);
    assert.equal(worktreePreparations, 0);
    assert.equal(intake?.stage, 'prepared');
    assert.equal(store.writes.length, 1);
  });

  it('should adopt an observed worktree after its first checkpoint fails', async () => {
    const store = memoryStore();
    let failWorktreeCheckpoint = true;
    let observedWorktree: typeof worktree | undefined;
    let worktreePreparations = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({
        inspect: async () => observedWorktree,
        async prepare() {
          worktreePreparations += 1;
          observedWorktree = worktree;
          return worktree;
        },
      }),
      sessions: { prepare: async () => undefined },
      stateStore: {
        read: store.read,
        async write(next) {
          if (failWorktreeCheckpoint && next.items[itemKey]?.intake?.stage === 'prepared') {
            failWorktreeCheckpoint = false;
            throw new Error('state write failed');
          }
          await store.write(next);
        },
      },
    });

    await assert.rejects(orchestrator.reconcile('tanaabot', itemKey));
    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(worktreePreparations, 1);
    assert.equal(store.state().items[itemKey]?.intake?.stage, 'prepared');
    assert.equal(store.state().items[itemKey]?.intake?.failureCode, undefined);
  });

  it('should retire an assignment when provider authority is revoked', async () => {
    const store = memoryStore();
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => ({ authorized: false, reasonCode: 'item-unassigned' }),
      },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({ inspect: async () => worktree, prepare: async () => worktree }),
      sessions: { prepare: async () => undefined },
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(store.state().items[itemKey]?.disposition, 'retired');
    assert.equal(store.state().items[itemKey]?.intake?.stage, 'retired');
    assert.equal(store.state().items[itemKey]?.reasonCode, 'item-unassigned');
  });

  it('should preserve worktree proof while retiring prepared intake', async () => {
    const state = monitorState();
    const item = state.items[itemKey];
    assert.ok(item?.intake);
    item.disposition = 'retired';
    item.reasonCode = 'item-closed';
    item.intake = {
      ...item.intake,
      stage: 'prepared',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    const preparedIntake = structuredClone(item.intake);
    const store = memoryStore(state);
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({ inspect: async () => worktree, prepare: async () => worktree }),
      sessions: { prepare: async () => undefined },
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    const retired = store.state().items[itemKey];
    assert.equal(retired?.disposition, 'retired');
    assert.equal(retired?.reasonCode, 'item-closed');
    assert.deepEqual(retired?.intake, { ...preparedIntake, stage: 'retired' });
  });

  it('should classify value-free intake boundary failures', async () => {
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
            initialMode: githubNotificationWorkMode,
            lifecycles: lifecycles({
              inspect: async () => worktree,
              prepare: async () => worktree,
            }),
            sessions: { prepare: async () => undefined },
            stateStore: store,
          });
        },
      },
      {
        code: 'github-notification-worktree-inspection-failed',
        create(store: ReturnType<typeof memoryStore>) {
          return new GitHubNotificationAssignmentOrchestrator({
            authority: { inspect: async () => ({ authorized: true }) },
            initialMode: githubNotificationWorkMode,
            lifecycles: lifecycles({
              inspect: async () => {
                throw new Error('restricted inspection detail');
              },
              prepare: async () => worktree,
            }),
            sessions: { prepare: async () => undefined },
            stateStore: store,
          });
        },
      },
      {
        code: 'github-notification-worktree-preparation-failed',
        create(store: ReturnType<typeof memoryStore>) {
          return new GitHubNotificationAssignmentOrchestrator({
            authority: { inspect: async () => ({ authorized: true }) },
            initialMode: githubNotificationWorkMode,
            lifecycles: lifecycles({
              inspect: async () => undefined,
              prepare: async () => {
                throw new Error('restricted preparation detail');
              },
            }),
            sessions: { prepare: async () => undefined },
            stateStore: store,
          });
        },
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
      assert.equal(store.state().items[itemKey]?.intake?.failureCode, scenario.code);
    }
  });
});
