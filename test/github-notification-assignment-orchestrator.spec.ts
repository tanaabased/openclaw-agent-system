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
      async cleanupGitHub() {
        return { status: 'missing' };
      },
      inspectGitHub: worktrees.inspect,
      prepareGitHub: worktrees.prepare,
    }),
    new GitHubPullRequestLifecycle(),
  ]);
}

describe('channels/github/intake/assignment-orchestrator', () => {
  it('should checkpoint one issue worktree before its assignment response', async () => {
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
          assert.equal(store.state().items[itemKey]?.intake?.stage, 'prepared');
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
    assert.equal(sessionPreparations, 0);
    assert.equal(intake?.stage, 'prepared');
    assert.deepEqual(
      store.writes.map((state) => state.items[itemKey]?.intake?.stage),
      ['prepared'],
    );

    await orchestrator.respond('tanaabot', itemKey);

    assert.equal(sessionPreparations, 1);
  });

  it('should checkpoint canonical repository coordinates before preparing a worktree', async () => {
    const store = memoryStore();
    const item = store.state().items[itemKey];
    assert.ok(item);
    const repository = {
      archived: false,
      cloneUrl: 'https://github.com/tanaabased/big-test-bucket.git',
      databaseId: item.repositoryDatabaseId,
      defaultBranch: 'trunk',
      disabled: false,
      name: 'big-test-bucket',
      nodeId: item.repositoryNodeId,
      owner: {
        login: item.repositoryOwner,
        nodeId: item.repositoryOwnerNodeId,
        type: 'Organization',
      },
    };
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => ({ authorized: true, permission: 'maintain', repository }),
      },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({
        inspect: async () => undefined,
        async prepare(input) {
          assert.equal(input.cloneUrl, repository.cloneUrl);
          assert.equal(input.defaultBranch, repository.defaultBranch);
          assert.equal(store.state().items[itemKey]?.repositoryName, repository.name);
          return worktree;
        },
      }),
      sessions: { prepare: async () => undefined },
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    const refreshed = store.state().items[itemKey];
    assert.equal(refreshed?.repositoryCloneUrl, repository.cloneUrl);
    assert.equal(refreshed?.repositoryDefaultBranch, repository.defaultBranch);
    assert.equal(refreshed?.repositoryPermission, 'maintain');
    assert.equal(refreshed?.intake?.stage, 'prepared');
  });

  it('should preserve prepared intake when its assignment response fails', async () => {
    const store = memoryStore();
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({ inspect: async () => undefined, prepare: async () => worktree }),
      sessions: {
        async prepare() {
          throw new Error('private assignment response failure');
        },
      },
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);
    await assert.rejects(
      orchestrator.respond('tanaabot', itemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationAssignmentOrchestratorError &&
        error.code === 'github-notification-assignment-session-recording-failed' &&
        !error.message.includes('private'),
    );

    assert.equal(store.state().items[itemKey]?.intake?.stage, 'prepared');
    assert.equal(store.state().items[itemKey]?.intake?.failureCode, undefined);
  });

  it('should preserve a bounded nested handoff diagnostic code', async () => {
    const store = memoryStore();
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({ inspect: async () => undefined, prepare: async () => worktree }),
      sessions: {
        async prepare() {
          throw Object.assign(new Error('private handoff detail'), {
            code: 'github-notification-pull-request-handoff-event-failed',
          });
        },
      },
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);
    await assert.rejects(
      orchestrator.respond('tanaabot', itemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationAssignmentOrchestratorError &&
        error.code === 'github-notification-pull-request-handoff-event-failed' &&
        !error.message.includes('private'),
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
        inspect: async () => ({
          authorized: false,
          providerVerified: true,
          reasonCode: 'item-unassigned',
        }),
      },
      clock: () => 10,
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({ inspect: async () => worktree, prepare: async () => worktree }),
      sessions: { prepare: async () => undefined },
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    assert.equal(store.state().items[itemKey]?.disposition, 'retired');
    assert.equal(store.state().items[itemKey]?.intake?.stage, 'retired');
    assert.equal(store.state().items[itemKey]?.intake?.providerRetirementVerifiedAt, 10);
    assert.equal(store.state().items[itemKey]?.reasonCode, 'item-unassigned');
  });

  it('should keep local retirement separate from provider cleanup authority', async () => {
    const store = memoryStore();
    let cleanupCalls = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: {
        inspect: async () => ({
          authorized: false,
          providerVerified: false,
          reasonCode: 'github-notification-route-revoked',
        }),
      },
      cleanup: {
        async cleanup() {
          cleanupCalls += 1;
          return {
            reasonCode: 'github-notification-cleanup-worktree-removed',
            session: 'archived',
            status: 'completed',
            worktree: 'removed',
          };
        },
      },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({ inspect: async () => worktree, prepare: async () => worktree }),
      sessions: { prepare: async () => undefined },
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);

    const retired = store.state().items[itemKey];
    assert.equal(retired?.disposition, 'retired');
    assert.equal(retired?.intake?.stage, 'retired');
    assert.equal(retired?.intake?.providerRetirementVerifiedAt, undefined);
    assert.equal(retired?.intake?.cleanup, undefined);
    assert.equal(cleanupCalls, 0);
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

  it('should retry provider-authorized cleanup until it completes', async () => {
    const state = monitorState();
    const item = state.items[itemKey];
    assert.ok(item?.intake);
    item.disposition = 'retired';
    item.reasonCode = 'item-closed';
    item.intake = {
      ...item.intake,
      providerRetirementVerifiedAt: 10,
      stage: 'retired',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    const store = memoryStore(state);
    let cleanupCalls = 0;
    const orchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      cleanup: {
        async cleanup() {
          cleanupCalls += 1;
          return cleanupCalls === 1
            ? {
                reasonCode: 'github-notification-cleanup-worktree-dirty',
                session: 'archived',
                status: 'skipped',
                worktree: 'dirty',
              }
            : {
                reasonCode: 'github-notification-cleanup-worktree-removed',
                session: 'archived',
                status: 'completed',
                worktree: 'removed',
              };
        },
      },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles({ inspect: async () => worktree, prepare: async () => worktree }),
      sessions: { prepare: async () => undefined },
      stateStore: store,
    });

    await orchestrator.reconcile('tanaabot', itemKey);
    assert.equal(store.state().items[itemKey]?.intake?.cleanup?.status, 'skipped');

    await orchestrator.reconcile('tanaabot', itemKey);
    assert.equal(store.state().items[itemKey]?.intake?.cleanup?.status, 'completed');
    assert.equal(cleanupCalls, 2);
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
