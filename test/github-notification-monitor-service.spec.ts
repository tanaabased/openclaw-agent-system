import assert from 'node:assert/strict';

import GitHubNotificationAssignmentOrchestrator, {
  GitHubNotificationAssignmentOrchestratorError,
} from '../channels/github/lib/assignment-orchestrator.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubPullRequestLifecycle from '../channels/github/lifecycles/pull-request.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
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
      assignmentTypes: ['issue', 'pull-request'],
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

function githubResponse(body: unknown) {
  return {
    exitCode: 0,
    stderr: '',
    stdout: ['HTTP/2 200 OK', 'x-ratelimit-remaining: 100', '', JSON.stringify(body)].join('\n'),
    timedOut: false,
    truncated: false,
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

  it('should reconcile persisted intake backlog before the next remote poll', async () => {
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

  it('should leave prepared intake idle until the next remote poll', async () => {
    let connected = 0;
    const reconciled: string[] = [];
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    const intake = state.items[notificationItemKey]?.intake;
    assert.ok(intake);
    state.items[notificationItemKey]!.intake = {
      ...intake,
      stage: 'prepared',
      worktreeBranch: 'issue-7-branch',
      worktreePath: '/workspace/worktrees/issue-7',
    };
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

    const [result] = await service.runOnce();

    assert.equal(result?.code, 'github-notification-interval-active');
    assert.equal(connected, 0);
    assert.deepEqual(reconciled, []);
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

  it('should report comment failure without poisoning provider health or retirement', async () => {
    let state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    const intake = state.items[notificationItemKey]?.intake;
    assert.ok(intake);
    state.items[notificationItemKey]!.intake = {
      ...intake,
      stage: 'prepared',
      worktreeBranch: 'issue-7-branch',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    let connections = 0;
    const warnings: string[] = [];
    const service = new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          connections += 1;
          return {
            identity: { login: 'tanaabot', nodeId: 'U_agent' },
            async execute(argv) {
              if (argv.includes('/repos/tanaabased/example')) {
                return githubResponse({
                  archived: false,
                  cloneUrl: 'https://github.com/tanaabased/example.git',
                  databaseId: 3,
                  defaultBranch: 'main',
                  disabled: false,
                  name: 'example',
                  nodeId: 'R_repo',
                  owner: { login: 'tanaabased', nodeId: 'O_owner', type: 'Organization' },
                });
              }
              if (argv.includes('/repos/tanaabased/example/collaborators/tanaabot/permission')) {
                return githubResponse({ permission: 'write' });
              }
              if (argv.includes('/repos/tanaabased/example/issues/12')) {
                return githubResponse({
                  assignees: [{ login: 'tanaabot', nodeId: 'U_agent', type: 'User' }],
                  databaseId: 7,
                  isPullRequest: false,
                  nodeId: 'I_item',
                  number: 12,
                  state: 'open',
                  updatedAt: '2026-08-15T12:00:00.000Z',
                });
              }
              return githubResponse({ incomplete: false, items: [], totalCount: 0 });
            },
          };
        },
      },
      assignmentOrchestrator: {
        async reconcile(_agentId, itemKey) {
          const item = state.items[itemKey];
          if (item?.disposition === 'retired' && item.intake) item.intake.stage = 'retired';
        },
      },
      commentOrchestrator: {
        async reconcile() {
          throw Object.assign(new Error('private response detail'), {
            code: 'github-notification-response-publication-missing',
          });
        },
      },
      clock: () => 1_000,
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
        read: async () => structuredClone(state),
        write: async (next) => {
          state = structuredClone(next);
        },
      },
    });

    const [failed] = await service.runOnce({ agentId: 'tanaabot', bypassInterval: true });

    assert.equal(failed?.code, 'github-notification-response-publication-missing');
    assert.equal(failed?.status, 'failed');
    assert.equal(state.diagnosticCode, undefined);
    assert.equal(state.failureCount, 0);
    assert.equal(state.lastSuccessfulPollAt, 1_000);
    assert.ok(warnings.every((message) => !message.includes('private response detail')));

    state.items[notificationItemKey]!.disposition = 'retired';
    state.items[notificationItemKey]!.reasonCode = 'item-closed';
    const [retired] = await service.runOnce({ agentId: 'tanaabot' });

    assert.equal(retired?.code, 'github-notification-pending-reconciled');
    assert.equal(retired?.status, 'completed');
    assert.equal(state.items[notificationItemKey]?.intake?.stage, 'retired');
    assert.equal(connections, 1);
  });

  it('should reconcile transitional retirement before the next remote poll', async () => {
    let state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    const intake = state.items[notificationItemKey]?.intake;
    assert.ok(intake);
    const worktree = {
      branch: 'issue-7-branch',
      path: '/workspace/worktrees/issue-7',
    };
    state.items[notificationItemKey] = {
      ...state.items[notificationItemKey]!,
      intake: {
        ...intake,
        stage: 'prepared',
        worktreeBranch: worktree.branch,
        worktreePath: worktree.path,
      },
      disposition: 'retired',
      reasonCode: 'item-closed',
    };
    const stateStore = {
      async read() {
        return structuredClone(state);
      },
      async write(next: GitHubNotificationMonitorState) {
        state = structuredClone(next);
      },
    };
    let worktreeOperations = 0;
    const assignmentOrchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      lifecycles: new GitHubNotificationLifecycleRegistry([
        new GitHubIssueLifecycle({
          async inspectGitHub() {
            worktreeOperations += 1;
            return worktree;
          },
          async prepareGitHub() {
            worktreeOperations += 1;
            return worktree;
          },
        }),
        new GitHubPullRequestLifecycle(),
      ]),
      sessions: { prepare: async () => undefined },
      stateStore,
    });
    const service = new GitHubNotificationMonitorService({
      accountClient: { connect: async () => Promise.reject(new Error('unexpected poll')) },
      assignmentOrchestrator,
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
      stateStore,
    });

    const [result] = await service.runOnce();

    assert.equal(result?.code, 'github-notification-pending-reconciled');
    assert.equal(state.items[notificationItemKey]?.intake?.stage, 'retired');
    assert.equal(state.items[notificationItemKey]?.intake?.worktreeBranch, worktree.branch);
    assert.equal(state.items[notificationItemKey]?.intake?.worktreePath, worktree.path);
    assert.equal(worktreeOperations, 0);
  });

  it('should verify exact routing before resolving a credential', async () => {
    let connected = 0;
    const reconciled: string[] = [];
    let state: GitHubNotificationMonitorState | undefined = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    const intake = state.items[notificationItemKey]?.intake;
    assert.ok(intake);
    state.items[notificationItemKey]!.intake = {
      ...intake,
      stage: 'prepared',
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
          if (item?.intake) {
            item.disposition = 'retired';
            item.intake.stage = 'retired';
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
    assert.equal(state?.items[notificationItemKey]?.intake?.stage, 'retired');
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
    const intake = state.items[notificationItemKey]?.intake;
    assert.ok(intake);
    state.items[notificationItemKey]!.intake = {
      ...intake,
      stage: 'prepared',
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
          if (item?.intake) {
            item.disposition = 'retired';
            item.intake.stage = 'retired';
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
