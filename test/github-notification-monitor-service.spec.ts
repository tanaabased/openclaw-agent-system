import assert from 'node:assert/strict';

import type { GitHubNotificationMonitorStateUpdate } from '../channels/github/intake/monitor/state-store.ts';

import AgentSystemToolError from '../api/error.ts';
import GitHubNotificationAssignmentOrchestrator, {
  GitHubNotificationAssignmentOrchestratorError,
} from '../channels/github/intake/assignment-orchestrator.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubPullRequestLifecycle from '../channels/github/lifecycles/pull-request.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import GitHubNotificationMonitorService, {
  type GitHubNotificationMonitorServiceDependencies,
} from '../channels/github/intake/monitor/service.ts';
import { GitHubAccountClientError } from '../core/github-account-client.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/intake/monitor/state.ts';
import type { AgentManifest } from '../manifest/types.ts';
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

function monitorService(
  overrides: Partial<GitHubNotificationMonitorServiceDependencies> = {},
): GitHubNotificationMonitorService {
  return new GitHubNotificationMonitorService({
    inspectReadiness: () => ({
      code: 'github-notification-hook-ready',
      message: 'ready',
      status: 'healthy',
    }),
    accountClient: { connect: async () => Promise.reject(new Error('unexpected poll')) },
    assignmentOrchestrator: {
      reconcile: async () => undefined,
      respond: async () => undefined,
    },
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
      read: async () => undefined,
      update: async (_agentId, patch) => patch(undefined),
    },
    ...overrides,
  });
}

describe('channels/github/intake/monitor/service', () => {
  it('should block hookless gateway work before provider access and recover after repair', async () => {
    let ready = false;
    let providerCalls = 0;
    let state: GitHubNotificationMonitorState | undefined;
    const service = monitorService({
      clock: () => 1000,
      inspectReadiness: () =>
        ready
          ? { code: 'github-notification-hook-ready', message: 'ready', status: 'healthy' }
          : {
              code: 'github-notification-hook-access-required',
              message: 'hook denied',
              status: 'blocked',
            },
      accountClient: {
        async connect() {
          providerCalls++;
          throw new Error('provider reached');
        },
      },
      stateStore: {
        read: async () => state,
        update: async (_id, patch) => {
          state = await patch(state);
          return state;
        },
      },
    });
    const [blocked] = await service.runOnce();
    assert.equal(blocked?.code, 'github-notification-hook-access-required');
    assert.equal(state?.diagnosticCode, 'github-notification-hook-access-required');
    assert.equal(providerCalls, 0);
    ready = true;
    await service.runOnce();
    assert.equal(providerCalls, 1);
  });

  it('should skip an explicitly empty roster without inspecting manifests or state', async () => {
    for (const config of [{ agents: { entries: {} } }, { agents: { list: [] } }]) {
      const service = monitorService({
        readConfig: async () => config,
        manifestService: {
          async loadForAgentId() {
            throw new Error('an empty roster has no agent to inspect');
          },
        },
      });
      assert.deepEqual(await service.runOnce(), []);
    }
  });

  it('should stop an account scheduler without surfacing the host abort', async () => {
    const service = monitorService({
      readConfig: async () => ({ agents: { list: [] } }),
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
    const service = monitorService({
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
      logger: { error() {}, info() {}, warn: (message) => warnings.push(message) },
      stateStore: {
        read: async () => structuredClone(state),
        update: async (_agentId, patch) => {
          writes += 1;
          return patch(state);
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

  it('should continue comment reconciliation after a backlogged assignment response fails', async () => {
    let connected = 0;
    const commentExecutions: string[] = [];
    const controller = new AbortController();
    const reconciled: string[] = [];
    const executionSurfaces: string[] = [];
    const operations: string[] = [];
    const warnings: string[] = [];
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    const service = monitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new Error('the monitor poll should remain deferred');
        },
      },
      assignmentOrchestrator: {
        async reconcile(_agentId, itemKey) {
          reconciled.push(itemKey);
          const intake = state.items[itemKey]?.intake;
          if (intake) {
            state.items[itemKey]!.intake = {
              ...intake,
              stage: 'prepared',
              worktreeBranch: 'issue-7-branch',
              worktreePath: '/workspace/worktrees/issue-7',
            };
          }
        },
        async respond(_agentId, _itemKey, _signal, executionSurface) {
          operations.push('assignment-response');
          executionSurfaces.push(executionSurface ?? 'missing');
          throw new GitHubNotificationAssignmentOrchestratorError(
            'github-notification-assignment-session-recording-failed',
            'The assignment response could not be reconciled.',
            {
              cause: new AgentSystemToolError(
                'operation_unclassified',
                'private assignment response failure',
              ),
            },
          );
        },
      },
      clock: () => 1_000,
      commentOrchestrator: {
        async reconcile(_agentId, _itemKey, options) {
          operations.push('comment');
          commentExecutions.push(options?.executionSurface ?? 'missing');
        },
      },
      logger: { error() {}, info() {}, warn: (message) => warnings.push(message) },
      stateStore: {
        read: async () => structuredClone(state),
        update: async (_agentId, patch) => patch(structuredClone(state)),
      },
    });

    const [result] = await service.runOnce({
      executionSurface: 'cli-one-shot',
      signal: controller.signal,
    });

    assert.equal(result?.code, 'github-notification-pending-reconciled');
    assert.equal(result?.status, 'completed');
    assert.equal(connected, 0);
    assert.deepEqual(reconciled, [notificationItemKey]);
    assert.deepEqual(executionSurfaces, ['cli-one-shot']);
    assert.deepEqual(commentExecutions, ['cli-one-shot']);
    assert.deepEqual(operations, ['comment', 'assignment-response']);
    assert.ok(
      warnings.some(
        (message) =>
          message.includes('github-notification-assignment-session-recording-failed') &&
          message.includes('causeCode=operation_unclassified'),
      ),
    );
    assert.ok(
      warnings.every((message) => !message.includes('private assignment response failure')),
    );
  });

  it('should retain the completed cli result when another worker finishes before selection', async () => {
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    let reads = 0;
    const service = monitorService({
      clock: () => 1_000,
      stateStore: {
        read: async () => (++reads === 1 ? structuredClone(state) : { ...state, items: {} }),
        update: async () => assert.fail('a deferred poll must not write'),
      },
      assignmentOrchestrator: {
        reconcile: async () => assert.fail('the pending item has already finished'),
        respond: async () => assert.fail('the pending item has already finished'),
      },
    });
    const [result] = await service.runOnce({
      agentId: 'tanaabot',
      executionSurface: 'cli-one-shot',
    });
    assert.equal(result?.status, 'completed');
    assert.equal(result?.code, 'github-notification-pending-reconciled');
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
    const service = monitorService({
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
        respond: async () => undefined,
      },
      clock: () => 1_000,
      stateStore: {
        read: async () => structuredClone(state),
        update: async (_agentId, patch) => patch(structuredClone(state)),
      },
    });

    const [result] = await service.runOnce();

    assert.equal(result?.code, 'github-notification-interval-active');
    assert.equal(connected, 0);
    assert.deepEqual(reconciled, []);
  });

  it('should recheck workspace and routing after acquiring execution ownership', async () => {
    for (const changedBoundary of ['workspace', 'routing'] as const) {
      const state = notificationMonitorState();
      state.agentId = 'tanaabot';
      state.workspaceDir = workspaceDir;
      state.nextPollAt = 10_000;
      let executing = false;
      let responses = 0;
      const released: string[] = [];
      const service = monitorService({
        clock: () => 1_000,
        assignmentOrchestrator: {
          reconcile: async () => undefined,
          async respond() {
            responses += 1;
          },
        },
        cycleLeaseStore: {
          async acquire(_agentId, options) {
            const scope = options?.scope ?? 'poll';
            if (scope === 'execution') executing = true;
            return {
              status: 'acquired',
              lease: {
                async release() {
                  released.push(scope);
                },
              },
            };
          },
        },
        manifestService: {
          async loadForAgentId() {
            const loaded = loadedManifest();
            if (executing && changedBoundary === 'workspace')
              loaded.scope.workspaceDir = '/changed';
            return loaded;
          },
        },
        routingService: {
          inspect: async () =>
            executing && changedBoundary === 'routing'
              ? { code: 'notification-routing-repair-required', kind: 'upsert', message: 'repair' }
              : { code: 'notification-routing-ready', kind: 'noop', message: 'ready' },
        },
        stateStore: {
          read: async () => structuredClone(state),
          update: async (_agentId, patch) => patch(state),
        },
      });
      const [result] = await service.runOnce({ agentId: 'tanaabot' });
      assert.equal(
        result?.code,
        changedBoundary === 'workspace'
          ? 'github-notification-execution-context-changed'
          : 'notification-routing-repair-required',
      );
      assert.equal(responses, 0);
      assert.deepEqual(released, ['poll', 'execution']);
      assert.equal(state.failureCount, 0);
    }
  });

  it('should supervise background execution failure and release ownership without provider backoff', async () => {
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    const controller = new AbortController();
    const failed = Promise.withResolvers<void>();
    const released: string[] = [];
    const service = monitorService({
      clock: () => 1_000,
      assignmentOrchestrator: {
        async reconcile() {
          throw new Error('private execution failure');
        },
        respond: async () => undefined,
      },
      cycleLeaseStore: {
        async acquire(_agentId, options) {
          return {
            status: 'acquired',
            lease: {
              async release() {
                released.push(options?.scope ?? 'poll');
              },
            },
          };
        },
      },
      logger: {
        error() {},
        info() {},
        warn(message) {
          assert.equal(message.includes('private execution failure'), false);
          if (message.includes('executor failed')) failed.resolve();
        },
      },
      async sleep() {
        await failed.promise;
        controller.abort();
      },
      stateStore: {
        read: async () => structuredClone(state),
        async update() {
          assert.fail('execution failure must not update provider health');
        },
      },
    });
    await service.runAccount('tanaabot', controller.signal);
    assert.deepEqual(released, ['poll', 'execution']);
    assert.equal(state.failureCount, 0);
    assert.equal(state.nextPollAt, 10_000);
  });

  it('should surface assignment boundary failure without changing provider backoff', async () => {
    let state: GitHubNotificationMonitorState | undefined = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    const service = monitorService({
      assignmentOrchestrator: {
        async reconcile() {
          throw new GitHubNotificationAssignmentOrchestratorError(
            'github-notification-worktree-preparation-failed',
            'The notification worktree could not be prepared.',
          );
        },
        respond: async () => undefined,
      },
      clock: () => 1_000,
      random: () => 0.5,
      stateStore: {
        read: async () => structuredClone(state),
        update: async (_agentId, patch) => {
          state = structuredClone(patch(state));
          return state;
        },
      },
    });

    const [result] = await service.runOnce({ agentId: 'tanaabot' });

    assert.deepEqual(result, {
      agentId: 'tanaabot',
      baselineAt: 1,
      code: 'github-notification-worktree-preparation-failed',
      nextPollAt: 10_000,
      status: 'failed',
    });
    assert.equal(state?.diagnosticCode, undefined);
    assert.equal(state?.failureCount, 0);
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
    const commentExecutions: string[] = [];
    const warnings: string[] = [];
    const service = monitorService({
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
        respond: async () => undefined,
      },
      commentOrchestrator: {
        async reconcile(_agentId, _itemKey, options) {
          commentExecutions.push(options?.executionSurface ?? 'missing');
          throw Object.assign(new Error('private response detail'), {
            code: 'github-notification-publication-candidate-missing',
          });
        },
      },
      clock: () => 1_000,
      logger: { error() {}, info() {}, warn: (message) => warnings.push(message) },
      random: () => 0.5,
      stateStore: {
        read: async () => structuredClone(state),
        update: async (_agentId, patch) => {
          state = structuredClone(patch(state));
          return state;
        },
      },
    });

    const [failed] = await service.runOnce({
      agentId: 'tanaabot',
      bypassInterval: true,
      executionSurface: 'cli-one-shot',
    });

    assert.equal(failed?.code, 'github-notification-publication-candidate-missing');
    assert.equal(failed?.status, 'failed');
    assert.equal(state.diagnosticCode, undefined);
    assert.equal(state.failureCount, 0);
    assert.equal(state.lastSuccessfulPollAt, 1_000);
    assert.deepEqual(commentExecutions, ['cli-one-shot']);
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
      async update(_agentId: string, patch: GitHubNotificationMonitorStateUpdate) {
        state = structuredClone(patch(state));
        return state;
      },
    };
    let worktreeOperations = 0;
    const assignmentOrchestrator = new GitHubNotificationAssignmentOrchestrator({
      authority: { inspect: async () => ({ authorized: true }) },
      initialMode: githubNotificationWorkMode,
      lifecycles: new GitHubNotificationLifecycleRegistry([
        new GitHubIssueLifecycle({
          async cleanupGitHub() {
            return { status: 'missing' };
          },
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
    const service = monitorService({
      assignmentOrchestrator,
      clock: () => 1_000,
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
    const service = monitorService({
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
        respond: async () => undefined,
      },
      clock: () => 1_000,
      random: () => 0.5,
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-repair-required',
          kind: 'upsert',
          message: 'repair',
        }),
      },
      stateStore: {
        read: async () => state,
        update: async (_agentId, patch) => {
          state = structuredClone(patch(state));
          return state;
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
    const service = monitorService({
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
        respond: async () => undefined,
      },
      clock: () => 1_000,
      manifestService: { loadForAgentId: async () => loadedManifest(disabledManifest) },
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
        update: async (_agentId, patch) => {
          state = structuredClone(patch(state));
          return state;
        },
      },
    });

    await service.runOnce();

    assert.equal(connected, 0);
    assert.deepEqual(reconciled, [notificationItemKey]);
    assert.equal(removals, 1);
    assert.equal(state, undefined);
  });

  it('should retire another disabled issue while one issue remains deferred', async () => {
    const state = notificationMonitorState();
    state.agentId = 'tanaabot';
    state.workspaceDir = workspaceDir;
    state.nextPollAt = 10_000;
    const first = state.items[notificationItemKey]!;
    const other = structuredClone(first);
    other.number += 1;
    const otherKey = `github:${other.repositoryNodeId}:${other.number}`;
    state.items[otherKey] = other;
    first.intake!.failureCode = 'github-notification-intake-failed';
    const retired: string[] = [];
    const service = monitorService({
      clock: () => 1_000,
      manifestService: {
        loadForAgentId: async () =>
          loadedManifest({
            ...manifest,
            github: { token: 'GH_TOKEN_TANAABOT', username: 'tanaabot' },
          }),
      },
      assignmentOrchestrator: {
        async reconcile(_agentId, itemKey) {
          retired.push(itemKey);
          state.items[itemKey]!.intake!.stage = 'retired';
        },
        respond: async () => assert.fail('disabled issues must not respond'),
      },
      stateStore: {
        read: async () => structuredClone(state),
        update: async (_agentId, patch) => patch(state),
        remove: async () => assert.fail('state must retain the deferred issue'),
      },
    });
    const [result] = await service.runOnce({ agentId: 'tanaabot' });
    assert.equal(result?.code, 'github-notification-disabled');
    assert.deepEqual(retired, [otherKey]);
    assert.equal(first.intake?.stage, 'admitted');
    assert.equal(other.intake?.stage, 'retired');
  });

  it('should persist value-free exponential backoff after a transient account failure', async () => {
    let state: GitHubNotificationMonitorState | undefined;
    const warnings: string[] = [];
    const service = monitorService({
      accountClient: {
        async connect() {
          throw new GitHubAccountClientError(
            'github-account-identity-failed',
            'private provider detail',
          );
        },
      },
      clock: () => 10_000,
      logger: { error() {}, info() {}, warn: (message) => warnings.push(message) },
      random: () => 0.5,
      stateStore: {
        read: async () => state,
        update: async (_agentId, patch) => {
          state = structuredClone(patch(state));
          return state;
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
    const service = monitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new GitHubAccountClientError('github-account-identity-failed', 'private detail');
        },
      },
      clock: () => 1_000,
      stateStore: {
        read: async () => structuredClone(state),
        update: async (_agentId, patch) => patch(structuredClone(state)),
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
    const service = monitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new Error('should remain deferred');
        },
      },
      clock: () => 1_000,
      stateStore: {
        read: async () => structuredClone(state),
        update: async (_agentId, patch) => patch(structuredClone(state)),
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
    const service = monitorService({
      accountClient: {
        async connect() {
          connected += 1;
          throw new GitHubAccountClientError('github-account-identity-failed', 'private detail');
        },
      },
      clock: () => 1_000,
      stateStore: {
        read: async () => structuredClone(state),
        update: async (_agentId, patch) => patch(structuredClone(state)),
      },
    });

    const [result] = await service.runOnce({ agentId: 'tanaabot', bypassInterval: true });

    assert.equal(connected, 1);
    assert.equal(result?.code, 'github-account-identity-failed');
    assert.equal(result?.status, 'failed');
  });

  it('should skip a cycle held by another process before reading agent state', async () => {
    let manifests = 0;
    const service = monitorService({
      cycleLeaseStore: { acquire: async () => ({ status: 'busy' }) },
      manifestService: {
        async loadForAgentId() {
          manifests += 1;
          return loadedManifest();
        },
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
