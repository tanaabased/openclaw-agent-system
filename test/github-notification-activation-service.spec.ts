import assert from 'node:assert/strict';

import GitHubNotificationActivationService from '../channels/github/lib/activation-service.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import {
  approvedPullRequestNotificationItem,
  notificationItemKey,
  notificationMonitorState,
  notificationPullRequestItemKey,
} from './github-notification-fixtures.ts';

function activeState(): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  state.items[notificationItemKey]!.delivery = {
    activation: { status: 'pending' },
    assignmentEventId: 'EV_assignment',
    mode: 'plan',
    schemaVersion: 1,
    sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
    stage: 'active',
    workId: 'issue-7',
    worktreeBranch: 'agent/tanaabot/issue-7',
    worktreePath: '/workspace/worktrees/issue-7',
  };
  return state;
}

function activePullRequestState(): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  const item = approvedPullRequestNotificationItem();
  item.delivery = {
    activation: { status: 'pending' },
    assignmentEventId: item.assignmentEventNodeId!,
    mode: 'plan',
    schemaVersion: 1,
    sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:13',
    stage: 'active',
    workId: 'pull-request-8',
  };
  state.items = { [notificationPullRequestItemKey]: item };
  return state;
}

function memoryStore(initial = activeState()) {
  let state = structuredClone(initial);
  return {
    read: async () => structuredClone(state),
    state: () => structuredClone(state),
    async write(next: GitHubNotificationMonitorState) {
      state = structuredClone(next);
    },
  };
}

function leaseStore() {
  return {
    async acquire() {
      return { lease: { release: async () => undefined }, status: 'acquired' as const };
    },
  };
}

const logger = { error() {}, info() {}, warn() {} };
const planningContext = {
  body: 'Please implement this.',
  comments: [],
  labels: ['feature'],
  title: 'Implement this',
  truncated: false,
};

describe('channels/github/lib/activation-service', () => {
  it('should checkpoint private planning before its public response', async () => {
    const store = memoryStore();
    let plans = 0;
    const service = new GitHubNotificationActivationService({
      authority: {
        loadPlanningContext: async () => ({ authorized: true, context: planningContext }),
      },
      leaseStore: leaseStore(),
      logger,
      sessions: {
        async planAssignment(input) {
          plans += 1;
          await input.onTurnAdopted();
          assert.equal(
            store.state().items[notificationItemKey]?.delivery?.activation?.status,
            'adopted',
          );
          await input.onPlanningCompleted();
          assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.activation, {
            reply: { status: 'pending' },
            status: 'planned',
          });
          return {
            reply: { commentId: 91, status: 'published' },
            status: 'planned',
          };
        },
      },
      stateStore: store,
    });
    const controller = new AbortController();

    assert.equal(service.schedule('tanaabot', controller.signal), 'scheduled');
    assert.equal(service.schedule('tanaabot', controller.signal), 'already-scheduled');
    await service.settle('tanaabot');

    assert.equal(plans, 1);
    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.activation, {
      reply: { commentId: 91, status: 'published' },
      status: 'planned',
    });
  });

  it('should plan an active pull request without a managed worktree', async () => {
    const store = memoryStore(activePullRequestState());
    let plans = 0;
    const service = new GitHubNotificationActivationService({
      authority: {
        loadPlanningContext: async () => ({ authorized: true, context: planningContext }),
      },
      leaseStore: leaseStore(),
      logger,
      sessions: {
        async planAssignment(input) {
          plans += 1;
          assert.equal(input.item.itemType, 'pull-request');
          assert.equal(input.worktree, undefined);
          await input.onTurnAdopted();
          await input.onPlanningCompleted();
          return {
            reply: { commentId: 93, status: 'published' },
            status: 'planned',
          };
        },
      },
      stateStore: store,
    });

    service.schedule('tanaabot', new AbortController().signal);
    await service.settle('tanaabot');

    assert.equal(plans, 1);
    assert.deepEqual(store.state().items[notificationPullRequestItemKey]?.delivery?.activation, {
      reply: { commentId: 93, status: 'published' },
      status: 'planned',
    });
  });

  it('should preserve a private plan when its public response fails', async () => {
    const store = memoryStore();
    const info: string[] = [];
    const warnings: string[] = [];
    const service = new GitHubNotificationActivationService({
      authority: {
        loadPlanningContext: async () => ({ authorized: true, context: planningContext }),
      },
      leaseStore: leaseStore(),
      logger: {
        error() {},
        info(message) {
          info.push(message);
        },
        warn(message) {
          warnings.push(message);
        },
      },
      sessions: {
        async planAssignment(input) {
          await input.onTurnAdopted();
          await input.onPlanningCompleted();
          return {
            reply: {
              failureCode: 'github-notification-planning-reply-not-confirmed',
              status: 'failed',
            },
            status: 'planned',
          };
        },
      },
      stateStore: store,
    });
    const controller = new AbortController();

    service.schedule('tanaabot', controller.signal);
    await service.settle('tanaabot');

    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.activation, {
      reply: {
        failureCode: 'github-notification-planning-reply-not-confirmed',
        status: 'failed',
      },
      status: 'planned',
    });
    assert.equal(
      info.some(
        (message) => message.includes('planning complete') && message.includes('reply=failed'),
      ),
      true,
    );
    assert.deepEqual(warnings, []);
  });

  it('should not downgrade a private plan when its final reply checkpoint fails', async () => {
    const store = memoryStore();
    const warnings: string[] = [];
    const service = new GitHubNotificationActivationService({
      authority: {
        loadPlanningContext: async () => ({ authorized: true, context: planningContext }),
      },
      leaseStore: leaseStore(),
      logger: {
        error() {},
        info() {},
        warn(message) {
          warnings.push(message);
        },
      },
      sessions: {
        async planAssignment(input) {
          await input.onTurnAdopted();
          await input.onPlanningCompleted();
          return {
            reply: { commentId: 91, status: 'published' },
            status: 'planned',
          };
        },
      },
      stateStore: {
        read: store.read,
        async write(next) {
          const reply = next.items[notificationItemKey]?.delivery?.activation?.reply;
          if (reply?.status === 'published') throw new Error('checkpoint unavailable');
          await store.write(next);
        },
      },
    });

    service.schedule('tanaabot', new AbortController().signal);
    await service.settle('tanaabot');

    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.activation, {
      reply: { status: 'pending' },
      status: 'planned',
    });
    assert.equal(
      warnings.some((message) => message.includes('planning reply checkpoint deferred')),
      true,
    );
  });

  it('should retry only failures that happen before the host adopts the turn', async () => {
    const store = memoryStore();
    let attempts = 0;
    const service = new GitHubNotificationActivationService({
      authority: {
        loadPlanningContext: async () => ({ authorized: true, context: planningContext }),
      },
      leaseStore: leaseStore(),
      logger,
      sessions: {
        async planAssignment() {
          attempts += 1;
          throw new Error('temporary model failure');
        },
      },
      stateStore: store,
    });
    const controller = new AbortController();

    service.schedule('tanaabot', controller.signal);
    await service.settle('tanaabot');
    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.activation, {
      failureCode: 'github-notification-activation-failed',
      status: 'pending',
    });

    service.schedule('tanaabot', controller.signal);
    await service.settle('tanaabot');
    assert.equal(attempts, 2);
  });

  it('should not replay a turn that failed after host adoption', async () => {
    const store = memoryStore();
    let attempts = 0;
    const service = new GitHubNotificationActivationService({
      authority: {
        loadPlanningContext: async () => ({ authorized: true, context: planningContext }),
      },
      leaseStore: leaseStore(),
      logger,
      sessions: {
        async planAssignment(input) {
          attempts += 1;
          await input.onTurnAdopted();
          throw new Error('ambiguous completion');
        },
      },
      stateStore: store,
    });
    const controller = new AbortController();

    service.schedule('tanaabot', controller.signal);
    await service.settle('tanaabot');
    service.schedule('tanaabot', controller.signal);
    await service.settle('tanaabot');

    assert.equal(attempts, 1);
    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.activation, {
      failureCode: 'github-notification-activation-failed',
      status: 'failed',
    });
  });
});
