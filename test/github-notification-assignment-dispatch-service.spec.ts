import assert from 'node:assert/strict';

import GitHubNotificationAssignmentDispatchService from '../channels/github/lib/assignment-dispatch-service.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

const sessionKey = 'agent:tanaabot:agent-system-github:tanaabot:direct:github:item';

function readyState(): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  const delivery = state.items[notificationItemKey]?.delivery;
  assert.ok(delivery);
  state.items[notificationItemKey]!.delivery = {
    ...delivery,
    stage: 'worktree-ready',
    worktreeBranch: 'issue-7-branch',
    worktreePath: '/workspace/worktrees/issue-7',
  };
  return state;
}

function memoryStore(initial = readyState()) {
  let state = structuredClone(initial);
  return {
    async read() {
      return structuredClone(state);
    },
    state: () => structuredClone(state),
    async write(next: GitHubNotificationMonitorState) {
      state = structuredClone(next);
    },
  };
}

function leaseStore() {
  return {
    async acquire() {
      return {
        lease: { release: async () => undefined },
        status: 'acquired' as const,
      };
    },
  };
}

const context = {
  body: 'bounded issue body',
  comments: [],
  labels: ['bug'],
  title: 'notification issue',
  truncated: false,
};

describe('channels/github/lib/assignment-dispatch-service', () => {
  it('should checkpoint one adopted assignment turn through planning publication', async () => {
    const store = memoryStore();
    let turns = 0;
    const service = new GitHubNotificationAssignmentDispatchService({
      authority: { loadPlanningContext: async () => ({ authorized: true, context }) },
      leaseStore: leaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      sessions: {
        async planAssignment(input) {
          turns += 1;
          assert.equal(input.delivery.stage, 'worktree-ready');
          await input.onTurnAdopted({ key: sessionKey, mode: 'plan', status: 'received' });
          assert.equal(store.state().items[notificationItemKey]?.delivery?.stage, 'active');
          assert.equal(
            store.state().items[notificationItemKey]?.delivery?.activation?.status,
            'adopted',
          );
          await input.onAcknowledgmentCompleted({ commentId: 89, status: 'published' });
          await input.onPlanningCompleted();
          assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.activation, {
            reply: { status: 'pending' },
            status: 'planned',
          });
          return { reply: { commentId: 90, status: 'published' }, status: 'planned' };
        },
      },
      stateStore: store,
    });
    const controller = new AbortController();

    assert.equal(service.schedule('tanaabot', controller.signal), 'scheduled');
    await service.settle('tanaabot');

    const delivery = store.state().items[notificationItemKey]?.delivery;
    assert.equal(turns, 1);
    assert.equal(delivery?.stage, 'active');
    assert.equal(delivery?.sessionKey, sessionKey);
    assert.deepEqual(delivery?.acknowledgment, { commentId: 89, status: 'published' });
    assert.deepEqual(delivery?.activation, {
      reply: { commentId: 90, status: 'published' },
      status: 'planned',
    });
  });

  it('should retain a retryable diagnostic when dispatch fails before adoption', async () => {
    const store = memoryStore();
    const service = new GitHubNotificationAssignmentDispatchService({
      authority: { loadPlanningContext: async () => ({ authorized: true, context }) },
      leaseStore: leaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      sessions: {
        async planAssignment() {
          throw new Error('private runtime detail');
        },
      },
      stateStore: store,
    });
    const controller = new AbortController();

    service.schedule('tanaabot', controller.signal);
    await service.settle('tanaabot');

    const delivery = store.state().items[notificationItemKey]?.delivery;
    assert.equal(delivery?.stage, 'worktree-ready');
    assert.deepEqual(delivery?.activation, {
      failureCode: 'github-notification-assignment-dispatch-failed',
      status: 'pending',
    });
  });

  it('should migrate a legacy active pending activation through the direct turn', async () => {
    const state = readyState();
    const delivery = state.items[notificationItemKey]?.delivery;
    assert.ok(delivery);
    state.items[notificationItemKey]!.delivery = {
      ...delivery,
      activation: { status: 'pending' },
      sessionKey,
      stage: 'active',
    };
    const store = memoryStore(state);
    let turns = 0;
    const service = new GitHubNotificationAssignmentDispatchService({
      authority: { loadPlanningContext: async () => ({ authorized: true, context }) },
      leaseStore: leaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      sessions: {
        async planAssignment(input) {
          turns += 1;
          await input.onTurnAdopted({ key: sessionKey, mode: 'plan', status: 'received' });
          await input.onAcknowledgmentCompleted({ commentId: 89, status: 'published' });
          await input.onPlanningCompleted();
          return { reply: { commentId: 90, status: 'published' }, status: 'planned' };
        },
      },
      stateStore: store,
    });
    const controller = new AbortController();

    service.schedule('tanaabot', controller.signal);
    await service.settle('tanaabot');

    assert.equal(turns, 1);
    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.activation, {
      reply: { commentId: 90, status: 'published' },
      status: 'planned',
    });
  });

  it('should make a post-adoption dispatch failure terminal', async () => {
    const store = memoryStore();
    const service = new GitHubNotificationAssignmentDispatchService({
      authority: { loadPlanningContext: async () => ({ authorized: true, context }) },
      leaseStore: leaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      sessions: {
        async planAssignment(input) {
          await input.onTurnAdopted({ key: sessionKey, mode: 'plan', status: 'received' });
          throw new Error('private runtime detail');
        },
      },
      stateStore: store,
    });
    const controller = new AbortController();

    service.schedule('tanaabot', controller.signal);
    await service.settle('tanaabot');

    const delivery = store.state().items[notificationItemKey]?.delivery;
    assert.equal(delivery?.stage, 'active');
    assert.deepEqual(delivery?.activation, {
      failureCode: 'github-notification-assignment-dispatch-failed',
      status: 'failed',
    });
  });
});
