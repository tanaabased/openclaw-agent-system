import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationAssignmentOrchestrator from '../channels/github/intake/assignment-orchestrator.ts';
import GitHubNotificationMonitorCycleLeaseStore from '../channels/github/intake/monitor/cycle-lease.ts';
import GitHubNotificationMonitorService from '../channels/github/intake/monitor/service.ts';
import GitHubNotificationMonitorStateStore from '../channels/github/intake/monitor/state-store.ts';
import type { GitHubNotificationItemState } from '../channels/github/intake/monitor/state.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import type { GitHubNotificationLifecycleWorktree } from '../channels/github/lifecycles/types.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import type { ConnectedGitHubAccountClient } from '../core/github-account-client.ts';
import acquirePrivateStateFileLock, {
  privateStateFileLockBusyErrorCode,
} from '../core/private-state-file-lock.ts';
import type abortableDelay from '../utils/abortable-delay.ts';
import type { AgentManifest } from '../manifest/types.ts';
import {
  approvedNotificationItem,
  notificationAccount,
  notificationActor,
  notificationMonitorState,
  notificationRepository,
} from './github-notification-fixtures.ts';

export const schedulingIssueA = approvedNotificationItem();
export const schedulingIssueB: GitHubNotificationItemState = {
  ...approvedNotificationItem(),
  assignmentEventNodeId: 'EV_assignment_b',
  intake: { assignmentEventId: 'EV_assignment_b', stage: 'admitted' },
  itemDatabaseId: 8,
  itemNodeId: 'I_item_b',
  number: 13,
};

export function schedulingSelector(item: GitHubNotificationItemState) {
  return {
    itemType: item.itemType,
    number: item.number,
    repository: `${item.repositoryOwner}/${item.repositoryName}`,
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

/** Exercise real polling, reconciliation, leases, and persistence around a held session call. */
export default async function createGitHubNotificationSchedulingFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-system-notification-scheduling-'));
  const stateOptions = { rootDir };
  const stateStore = new GitHubNotificationMonitorStateStore(stateOptions);
  const initial = notificationMonitorState();
  await stateStore.write(initial);
  const manifest: AgentManifest = {
    schemaVersion: 1,
    agent: { id: notificationAccount.login },
    github: {
      notifications: {
        assignmentTypes: ['issue'],
        approvedActors: [notificationActor],
        intervalMinutes: 5,
      },
      token: 'GH_TOKEN_TANAABOT',
      username: notificationAccount.login,
    },
  };
  const arrivals = new Map([[schedulingIssueA.number, schedulingIssueA]]);
  const requests: string[] = [];
  const sessionCalls: number[] = [];
  const sessionSignals: AbortSignal[] = [];
  const worktreePreparations: number[] = [];
  const worktrees = new Map<number, GitHubNotificationLifecycleWorktree>();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const contended = Promise.withResolvers<void>();
  const warnings: string[] = [];
  const logger = { error() {}, info() {}, warn: (message: string) => warnings.push(message) };
  const repositoryPath = '/repos/tanaabased/example';
  const timestamp = new Date(2_000).toISOString();
  let now = 3_000;

  const account: ConnectedGitHubAccountClient = {
    identity: notificationAccount,
    async execute(argv) {
      const endpoint = argv.find((argument) => argument.startsWith('/'));
      if (!endpoint) throw new Error('The scheduling fixture requires a GitHub endpoint.');
      requests.push(endpoint);
      if (endpoint === repositoryPath) return githubResponse(notificationRepository);
      if (endpoint === `${repositoryPath}/collaborators/tanaabot/permission`) {
        return githubResponse({ permission: 'write' });
      }
      if (endpoint === '/search/issues') {
        return githubResponse({
          incomplete: false,
          items: [...arrivals.values()].map((item) => ({
            databaseId: item.itemDatabaseId,
            isPullRequest: false,
            nodeId: item.itemNodeId,
            number: item.number,
            repositoryPath,
            updatedAt: timestamp,
          })),
          totalCount: arrivals.size,
        });
      }
      for (const item of arrivals.values()) {
        const itemPath = `${repositoryPath}/issues/${item.number}`;
        if (endpoint === itemPath) {
          return githubResponse({
            assignees: [notificationAccount],
            databaseId: item.itemDatabaseId,
            isPullRequest: false,
            nodeId: item.itemNodeId,
            number: item.number,
            state: 'open',
            updatedAt: timestamp,
          });
        }
        if (endpoint === `${itemPath}/events`) {
          return githubResponse([
            {
              actor: notificationActor,
              assignee: notificationAccount,
              createdAt: timestamp,
              databaseId: item.itemDatabaseId + 100,
              event: 'assigned',
              nodeId: item.assignmentEventNodeId,
            },
          ]);
        }
      }
      throw new Error(`Unexpected scheduling fixture endpoint: ${endpoint}`);
    },
  };

  function createMonitor(
    beforePoll?: (store: GitHubNotificationMonitorStateStore) => Promise<void>,
    sleep?: typeof abortableDelay,
  ) {
    const store = new GitHubNotificationMonitorStateStore(stateOptions);
    return new GitHubNotificationMonitorService({
      accountClient: {
        async connect() {
          await beforePoll?.(store);
          return account;
        },
      },
      assignmentOrchestrator: new GitHubNotificationAssignmentOrchestrator({
        authority: { inspect: async () => ({ authorized: true }) },
        initialMode: githubNotificationWorkMode,
        lifecycles: new GitHubNotificationLifecycleRegistry([
          new GitHubIssueLifecycle({
            async cleanupGitHub() {
              throw new Error('Unexpected scheduling fixture cleanup.');
            },
            inspectGitHub: async ({ itemDatabaseId }) => worktrees.get(itemDatabaseId),
            async prepareGitHub({ itemDatabaseId }) {
              worktreePreparations.push(itemDatabaseId);
              const worktree = {
                branch: `issue-${itemDatabaseId}`,
                path: `/workspace/worktrees/issue-${itemDatabaseId}`,
              };
              worktrees.set(itemDatabaseId, worktree);
              return worktree;
            },
          }),
        ]),
        sessions: {
          async prepare({ item, signal }) {
            sessionCalls.push(item.number);
            if (signal) sessionSignals.push(signal);
            if (item.number === schedulingIssueA.number) {
              started.resolve();
              await release.promise;
            }
          },
        },
        stateStore: store,
      }),
      clock: () => now,
      cycleLeaseStore: new GitHubNotificationMonitorCycleLeaseStore({
        ...stateOptions,
        async acquireFileLock(path, options) {
          try {
            return await acquirePrivateStateFileLock(path, options);
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === privateStateFileLockBusyErrorCode
            ) {
              contended.resolve();
            }
            throw error;
          }
        },
      }),
      logger,
      manifestService: {
        loadForAgentId: async () => ({
          status: 'loaded',
          scope: { agentId: initial.agentId, workspaceDir: initial.workspaceDir },
          path: `${initial.workspaceDir}/agent.yaml`,
          digest: 'digest',
          manifest,
          diagnostics: [],
          validationChecks: [],
        }),
      },
      random: () => 0.5,
      readConfig: () => ({
        agents: { list: [{ id: initial.agentId, workspace: initial.workspaceDir }] },
      }),
      routingService: {
        inspect: async () => ({
          code: 'notification-routing-ready',
          kind: 'noop',
          message: 'ready',
        }),
      },
      stateStore: store,
      ...(sleep === undefined ? {} : { sleep }),
    });
  }

  return {
    agentId: initial.agentId,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    contended: contended.promise,
    createMonitor,
    dispose: () => rm(rootDir, { force: true, recursive: true }),
    expose(item: GitHubNotificationItemState) {
      arrivals.set(item.number, structuredClone(item));
      now += 1_000;
    },
    readState: () => new GitHubNotificationMonitorStateStore(stateOptions).read(initial.agentId),
    release,
    requests,
    sessionCalls,
    sessionSignals,
    started: started.promise,
    warnings,
    worktreePreparations,
  };
}
