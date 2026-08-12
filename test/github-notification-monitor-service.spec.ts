import assert from 'node:assert/strict';

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
      repositoryPolicy: { minimumPermission: 'write' },
    },
    token: 'GH_TOKEN_TANAABOT',
    username: 'tanaabot',
  },
};

function loadedManifest() {
  return {
    status: 'loaded' as const,
    scope: { agentId: 'tanaabot', workspaceDir },
    path: `${workspaceDir}/agent.yaml`,
    digest: 'digest',
    manifest,
    diagnostics: [],
    validationChecks: [],
  };
}

describe('channels/github/lib/monitor-service', () => {
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
    let state: GitHubNotificationMonitorState | undefined;
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new Error('should not connect');
        },
      },
      assignmentOrchestrator: { reconcile: async () => undefined },
      clock: () => 1_000,
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
    assert.equal(state?.diagnosticCode, 'notification-routing-repair-required');
    assert.equal(state?.failureCount, 1);
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
});
