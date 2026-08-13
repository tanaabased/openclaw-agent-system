import assert from 'node:assert/strict';

import { GitHubNotificationAssignmentOrchestratorError } from '../channels/github/lib/assignment-orchestrator.ts';
import GitHubNotificationMonitorService from '../channels/github/lib/monitor-service.ts';
import { GitHubAccountClientError } from '../lib/github-account-client.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

const workspaceDir = '/workspace/tanaabot';
const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'tanaabot' },
  github: {
    notifications: {
      approvedActors: [{ login: 'pirog', nodeId: 'U_actor' }],
      intervalMinutes: 5,
    },
    token: 'GH_TOKEN_TANAABOT',
    username: 'tanaabot',
  },
};

function loadedManifest(loaded: AgentManifest = manifest) {
  return {
    status: 'loaded' as const,
    scope: { agentId: 'tanaabot', workspaceDir },
    path: `${workspaceDir}/agent.yaml`,
    digest: 'digest',
    manifest: loaded,
    diagnostics: [],
    validationChecks: [],
  };
}

function availableCycleLeaseStore(release = async () => undefined) {
  return {
    async acquire() {
      return { lease: { release }, status: 'acquired' as const };
    },
  };
}

describe('channels/github/lib/monitor-service', () => {
  it('should stop an account scheduler without surfacing the host abort', async () => {
    const service = new GitHubNotificationMonitorService({
      accountClient: { connect: async () => Promise.reject(new Error('unexpected poll')) },
      assignmentOrchestrator: { reconcile: async () => undefined },
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      readConfig: async () => ({ agents: { list: [] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => undefined,
        write: async () => undefined,
      },
    });

    const controller = new AbortController();
    controller.abort();

    await assert.doesNotReject(service.runAccount('tanaabot', controller.signal));
  });

  it('should skip an in-flight poll abort without changing monitor health', async () => {
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.lastSuccessfulPollAt = 500;
    const initialState = structuredClone(state);
    const cycles: Array<{ code: string; status: string }> = [];
    const warnings: string[] = [];
    let writes = 0;
    let markConnected!: () => void;
    const connected = new Promise<void>((resolve) => {
      markConnected = resolve;
    });
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect(_context, _trigger, signal) {
          markConnected();
          return await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () =>
                reject(new GitHubAccountClientError('github-account-tool-unavailable', 'aborted')),
              { once: true },
            );
          });
        },
      },
      assignmentOrchestrator: { reconcile: async () => undefined },
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn: (message) => warnings.push(message) },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => structuredClone(state),
        write: async () => {
          writes += 1;
        },
      },
    });
    const controller = new AbortController();

    const running = service.runAccount('tanaabot', controller.signal, (result) => {
      cycles.push({ code: result.code, status: result.status });
    });
    await connected;
    controller.abort();
    await running;

    assert.deepEqual(cycles, [{ code: 'github-notification-cycle-aborted', status: 'skipped' }]);
    assert.equal(writes, 0);
    assert.deepEqual(state, initialState);
    assert.deepEqual(warnings, []);
  });

  it('should reconcile persisted delivery backlog before the next remote poll', async () => {
    let connected = 0;
    const reconciled: string[] = [];
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new Error('the monitor poll should remain deferred');
        },
      },
      assignmentOrchestrator: {
        async reconcile(_agentId, itemKey) {
          reconciled.push(itemKey);
        },
      },
      clock: () => 1_000,
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => structuredClone(state),
        write: async () => undefined,
      },
    });

    await service.runOnce();

    assert.equal(connected, 0);
    assert.deepEqual(reconciled, [notificationItemKey]);
  });

  it('should surface the exact assignment boundary failure from a monitor cycle', async () => {
    let state: GitHubNotificationMonitorState | undefined = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    const service = new GitHubNotificationMonitorService({
      accountClient: { connect: async () => Promise.reject(new Error('unexpected poll')) },
      assignmentOrchestrator: {
        async reconcile() {
          throw new GitHubNotificationAssignmentOrchestratorError(
            'github-notification-worktree-preparation-failed',
            'The notification worktree could not be prepared.',
          );
        },
      },
      clock: () => 1_000,
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      random: () => 0.5,
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => structuredClone(state),
        write: async (next) => {
          state = structuredClone(next);
        },
      },
    });

    const [result] = await service.runOnce({ agentId: 'tanaabot' });

    assert.deepEqual(result, {
      agentId: 'tanaabot',
      baselineAt: 1,
      code: 'github-notification-worktree-preparation-failed',
      diagnosticCode: 'github-notification-worktree-preparation-failed',
      nextPollAt: 31_000,
      retryAt: 31_000,
      status: 'failed',
    });
    assert.equal(state?.diagnosticCode, 'github-notification-worktree-preparation-failed');
  });

  it('should reconcile transitional retirement before the next remote poll', async () => {
    const reconciled: string[] = [];
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    state.items[notificationItemKey] = {
      ...state.items[notificationItemKey]!,
      disposition: 'retired',
      reasonCode: 'item-unassigned',
    };
    const service = new GitHubNotificationMonitorService({
      accountClient: { connect: async () => Promise.reject(new Error('unexpected poll')) },
      assignmentOrchestrator: {
        async reconcile(_agentId, itemKey) {
          reconciled.push(itemKey);
        },
      },
      clock: () => 1_000,
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => structuredClone(state),
        write: async () => undefined,
      },
    });

    await service.runOnce();

    assert.deepEqual(reconciled, [notificationItemKey]);
  });

  it('should verify exact routing before resolving a credential', async () => {
    let connected = 0;
    const reconciled: string[] = [];
    let state: GitHubNotificationMonitorState | undefined = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    const delivery = state.items[notificationItemKey]?.delivery;
    assert.ok(delivery);
    state.items[notificationItemKey]!.delivery = {
      ...delivery,
      sessionId: 'session-1',
      sessionKey: 'agent:tanaabot:github:item',
      stage: 'active',
      worktreeBranch: 'issue-7-branch',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new Error('should not connect');
        },
      },
      assignmentOrchestrator: {
        async reconcile(_agentId, itemKey) {
          reconciled.push(itemKey);
          const item = state?.items[itemKey];
          if (item?.delivery) {
            item.disposition = 'retired';
            item.delivery.stage = 'retired';
          }
        },
      },
      clock: () => 1_000,
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      random: () => 0.5,
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-repair-required',
          kind: 'upsert',
          message: 'repair',
        }),
      },
      stateStore: {
        read: async () => state,
        write: async (next) => {
          state = structuredClone(next);
        },
      },
    });

    await service.runOnce();

    assert.equal(connected, 0);
    assert.deepEqual(reconciled, [notificationItemKey]);
    assert.equal(state?.items[notificationItemKey]?.delivery?.stage, 'retired');
    assert.equal(state?.diagnosticCode, 'notification-routing-repair-required');
    assert.equal(state?.failureCount, 1);
  });

  it('should retire disabled notification state without connecting to github', async () => {
    let connected = 0;
    let removals = 0;
    const reconciled: string[] = [];
    let state: GitHubNotificationMonitorState | undefined = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    const delivery = state.items[notificationItemKey]?.delivery;
    assert.ok(delivery);
    state.items[notificationItemKey]!.delivery = {
      ...delivery,
      sessionId: 'session-1',
      sessionKey: 'agent:tanaabot:github:item',
      stage: 'active',
      worktreeBranch: 'issue-7-branch',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    const disabledManifest: AgentManifest = {
      ...manifest,
      github: { token: 'GH_TOKEN_TANAABOT', username: 'tanaabot' },
    };
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new Error('should not connect');
        },
      },
      assignmentOrchestrator: {
        async reconcile(_agentId, itemKey) {
          reconciled.push(itemKey);
          const item = state?.items[itemKey];
          if (item?.delivery) {
            item.disposition = 'retired';
            item.delivery.stage = 'retired';
          }
        },
      },
      clock: () => 1_000,
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest(disabledManifest) },
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () =>
          Promise.reject(new Error('disabled retirement should not inspect routing')),
      },
      stateStore: {
        read: async () => (state ? structuredClone(state) : undefined),
        async remove() {
          removals += 1;
          state = undefined;
          return true;
        },
        write: async (next) => {
          state = structuredClone(next);
        },
      },
    });

    await service.runOnce();

    assert.equal(connected, 0);
    assert.deepEqual(reconciled, [notificationItemKey]);
    assert.equal(removals, 1);
    assert.equal(state, undefined);
  });

  it('should persist value-free exponential backoff after a transient account failure', async () => {
    let state: GitHubNotificationMonitorState | undefined;
    const warnings: string[] = [];
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          throw new GitHubAccountClientError(
            'github-account-identity-failed',
            'private provider detail',
          );
        },
      },
      assignmentOrchestrator: { reconcile: async () => undefined },
      clock: () => 10_000,
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn: (message) => warnings.push(message) },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      random: () => 0.5,
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => state,
        write: async (next) => {
          state = structuredClone(next);
        },
      },
    });

    await service.runOnce();

    assert.equal(state?.diagnosticCode, 'github-account-identity-failed');
    assert.equal(state?.nextPollAt, 40_000);
    assert.ok(!JSON.stringify(state).includes('private provider detail'));
    assert.ok(warnings.every((message) => !message.includes('private provider detail')));
  });

  it('should let a manual refresh bypass only the ordinary interval deadline', async () => {
    let connected = 0;
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.items = {};
    state.nextPollAt = 10_000;
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new GitHubAccountClientError('github-account-identity-failed', 'private detail');
        },
      },
      assignmentOrchestrator: { reconcile: async () => undefined },
      clock: () => 1_000,
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => structuredClone(state),
        write: async () => undefined,
      },
    });

    const [result] = await service.runOnce({ agentId: 'tanaabot', bypassInterval: true });

    assert.equal(connected, 1);
    assert.equal(result?.status, 'failed');
    assert.equal(result?.code, 'github-account-identity-failed');
  });

  it('should preserve active failure backoff for a manual refresh', async () => {
    let connected = 0;
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.items = {};
    state.diagnosticCode = 'github-account-identity-failed';
    state.failureCount = 1;
    state.nextPollAt = 10_000;
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new Error('should remain deferred');
        },
      },
      assignmentOrchestrator: { reconcile: async () => undefined },
      clock: () => 1_000,
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => structuredClone(state),
        write: async () => undefined,
      },
    });

    const [result] = await service.runOnce({ agentId: 'tanaabot', bypassInterval: true });

    assert.equal(connected, 0);
    assert.deepEqual(result, {
      agentId: 'tanaabot',
      baselineAt: 1,
      code: 'github-notification-backoff-active',
      diagnosticCode: 'github-account-identity-failed',
      nextPollAt: 10_000,
      retryAt: 10_000,
      status: 'skipped',
    });
  });

  it('should release a routing backoff after install repairs the route', async () => {
    let connected = 0;
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.baselineAt = undefined;
    state.items = {};
    state.diagnosticCode = 'notification-routing-install-required';
    state.failureCount = 5;
    state.nextPollAt = 10_000;
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new GitHubAccountClientError('github-account-identity-failed', 'private detail');
        },
      },
      assignmentOrchestrator: { reconcile: async () => undefined },
      clock: () => 1_000,
      cycleLeaseStore: availableCycleLeaseStore(),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => structuredClone(state),
        write: async () => undefined,
      },
    });

    const [result] = await service.runOnce({ agentId: 'tanaabot', bypassInterval: true });

    assert.equal(connected, 1);
    assert.equal(result?.code, 'github-account-identity-failed');
    assert.equal(result?.status, 'failed');
  });

  it('should skip a cycle held by another process before reading agent state', async () => {
    let manifests = 0;
    const service = new GitHubNotificationMonitorService({
      accountClient: { connect: async () => Promise.reject(new Error('unexpected poll')) },
      assignmentOrchestrator: { reconcile: async () => undefined },
      cycleLeaseStore: { acquire: async () => ({ status: 'busy' }) },
      logger: { error() {}, info() {}, warn() {} },
      manifestService: {
        async loadForAgentId() {
          manifests += 1;
          return loadedManifest();
        },
      },
      readConfig: async () => ({ agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] } }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: {
        read: async () => undefined,
        write: async () => undefined,
      },
    });

    const [result] = await service.runOnce({ agentId: 'tanaabot' });

    assert.equal(manifests, 0);
    assert.deepEqual(result, {
      agentId: 'tanaabot',
      code: 'github-notification-cycle-busy',
      status: 'skipped',
    });
  });
});
