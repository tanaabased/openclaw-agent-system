import assert from 'node:assert/strict';

import GitHubNotificationActivationService from '../channels/github/lib/activation-service.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

function activeState(): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  state.items[notificationItemKey]!.delivery = {
    acknowledgment: { status: 'pending' },
    activation: { status: 'pending' },
    assignmentEventId: 'EV_assignment',
    schemaVersion: 1,
    sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
    stage: 'active',
    workId: 'issue-7',
    worktreeBranch: 'agent/tanaabot/issue-7',
    worktreePath: '/workspace/worktrees/issue-7',
  };
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
  it('should checkpoint adoption, planning, and the durable acknowledgment receipt', async () => {
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
          return { acknowledgmentCommentId: 91 };
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
      status: 'planned',
    });
    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.acknowledgment, {
      commentId: 91,
      status: 'published',
    });
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
      status: 'adopted',
    });
  });
});
