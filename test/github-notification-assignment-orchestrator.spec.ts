import assert from 'node:assert/strict';

import GitHubNotificationAssignmentOrchestrator, {
  GitHubNotificationAssignmentOrchestratorError,
} from '../channels/github/lib/assignment-orchestrator.ts';
import GitHubIssueLifecycle, {
  type GitHubIssueLifecycleWorktreeService,
} from '../channels/github/lifecycles/issue.ts';
import GitHubPullRequestLifecycle from '../channels/github/lifecycles/pull-request.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
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

describe('channels/github/lib/assignment-orchestrator', () => {
  it('should prepare one issue worktree without creating a session or model turn', async () => {
    const store = memoryStore();
    let observedWorktree: typeof worktree | undefined;
    let worktreePreparations = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      lifecycles: lifecycles({
        inspect: async () => observedWorktree,
        async prepare() {
          worktreePreparations += 1;
          observedWorktree = worktree;
          return worktree;
        },
      }),
      stateStore: store,
    });

    await Promise.all([
      orchestrator.reconcile('tanaabot', itemKey),
      orchestrator.reconcile('tanaabot', itemKey),
    ]);

    const delivery = store.state().items[itemKey]?.delivery;
    assert.equal(worktreePreparations, 1);
    assert.equal(delivery?.stage, 'worktree-ready');
    assert.equal(delivery?.sessionKey, undefined);
    assert.equal(delivery?.activation, undefined);
    assert.deepEqual(
      store.writes.map((state) => state.items[itemKey]?.delivery?.stage),
      ['admitted', 'worktree-ready'],
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
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', notificationPullRequestItemKey);

    const delivery = store.state().items[notificationPullRequestItemKey]?.delivery;
    assert.equal(worktreeInspections, 0);
    assert.equal(worktreePreparations, 0);
    assert.equal(delivery?.stage, 'admitted');
    assert.equal(delivery?.sessionKey, undefined);
    assert.equal(store.writes.length, 0);
  });

  it('should adopt an observed worktree after its first checkpoint fails', async () => {
    const store = memoryStore();
    let failWorktreeCheckpoint = true;
    let observedWorktree: typeof worktree | undefined;
    let worktreePreparations = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      lifecycles: lifecycles({
        inspect: async () => observedWorktree,
        async prepare() {
          worktreePreparations += 1;
          observedWorktree = worktree;
          return worktree;
        },
      }),
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
    });

    await assert.rejects(orchestrator.reconcile('tanaabot', itemKey));
    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(worktreePreparations, 1);
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'worktree-ready');
    assert.equal(store.state().items[itemKey]?.delivery?.failureCode, undefined);
  });

  it('should retire an assignment when provider authority is revoked', async () => {
    const store = memoryStore();
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => ({ authorized: false, reasonCode: 'item-unassigned' }),
      },
      lifecycles: lifecycles({ inspect: async () => worktree, prepare: async () => worktree }),
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(store.state().items[itemKey]?.disposition, 'retired');
    assert.equal(store.state().items[itemKey]?.delivery?.stage, 'retired');
    assert.equal(store.state().items[itemKey]?.reasonCode, 'item-unassigned');
  });

  it('should preserve local proof while retiring an active delivery', async () => {
    const state = monitorState();
    const item = state.items[itemKey];
    assert.ok(item?.delivery);
    item.disposition = 'retired';
    item.reasonCode = 'item-closed';
    item.delivery = {
      ...item.delivery,
      activation: { reply: { commentId: 42, status: 'published' }, status: 'planned' },
      sessionId: 'session-1',
      sessionKey: 'agent:tanaabot:agent-system-github:tanaabot:direct:github:item',
      stage: 'active',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    const activeDelivery = structuredClone(item.delivery);
    const store = memoryStore(state);
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      lifecycles: lifecycles({ inspect: async () => worktree, prepare: async () => worktree }),
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    const retired = store.state().items[itemKey];
    assert.equal(retired?.disposition, 'retired');
    assert.equal(retired?.reasonCode, 'item-closed');
    assert.deepEqual(retired?.delivery, { ...activeDelivery, stage: 'retired' });
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
            lifecycles: lifecycles({
              inspect: async () => worktree,
              prepare: async () => worktree,
            }),
            stateStore: store,
          });
        },
      },
      {
        code: 'github-notification-worktree-inspection-failed',
        create(store: ReturnType<typeof memoryStore>) {
          return new GitHubNotificationAssignmentOrchestrator({
            authority: { inspect: async () => ({ authorized: true }) },
            lifecycles: lifecycles({
              inspect: async () => {
                throw new Error('restricted inspection detail');
              },
              prepare: async () => worktree,
            }),
            stateStore: store,
          });
        },
      },
      {
        code: 'github-notification-worktree-preparation-failed',
        create(store: ReturnType<typeof memoryStore>) {
          return new GitHubNotificationAssignmentOrchestrator({
            authority: { inspect: async () => ({ authorized: true }) },
            lifecycles: lifecycles({
              inspect: async () => undefined,
              prepare: async () => {
                throw new Error('restricted preparation detail');
              },
            }),
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
      assert.equal(store.state().items[itemKey]?.delivery?.failureCode, scenario.code);
    }
  });
});
