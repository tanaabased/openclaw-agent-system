import assert from 'node:assert/strict';

import GitHubNotificationAcknowledgmentService from '../channels/github/lib/acknowledgment-service.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import type { AgentSystemCliResult } from '../lib/tool-types.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

const workspaceDir = '/workspace';
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

function response(body: unknown): AgentSystemCliResult {
  return {
    exitCode: 0,
    stderr: '',
    stdout: ['HTTP/2 200 OK', 'x-ratelimit-remaining: 100', '', JSON.stringify(body)].join('\n'),
    timedOut: false,
    truncated: false,
  };
}

function activeState(): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  const delivery = state.items[notificationItemKey]!.delivery!;
  state.items[notificationItemKey]!.delivery = {
    ...delivery,
    sessionKey: 'agent:tanaabot:agent-system-github:tanaabot:direct:github:item',
    stage: 'active',
    worktreeBranch: 'agent/tanaabot/issue-7',
    worktreePath: '/workspace/.agent-system/worktrees/issue-7',
  };
  return state;
}

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

function memoryStore(initial = activeState()) {
  let state = structuredClone(initial);
  return {
    async read() {
      return structuredClone(state);
    },
    state() {
      return structuredClone(state);
    },
    async write(next: GitHubNotificationMonitorState) {
      state = structuredClone(next);
    },
  };
}

function leaseStore(scopes: string[]) {
  return {
    async acquire(_agentId: string, options: { scope?: string } = {}) {
      scopes.push(options.scope ?? 'cycle');
      return { lease: { async release() {} }, status: 'acquired' as const };
    },
  };
}

describe('channels/github/lib/acknowledgment-service', () => {
  it('should generate and publish once before checkpointing a value-free receipt', async () => {
    const store = memoryStore();
    const scopes: string[] = [];
    const requests: Array<{ argv: string[]; stdin?: string }> = [];
    let generations = 0;
    const service = new GitHubNotificationAcknowledgmentService({
      accountClient: {
        async connect() {
          return {
            identity: { login: 'tanaabot', nodeId: 'U_agent' },
            async execute(argv: string[], stdin?: string) {
              requests.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
              if (argv.includes('POST')) {
                const body = JSON.parse(stdin ?? '{}').body as string;
                return response({
                  body,
                  databaseId: 91,
                  nodeId: 'IC_published',
                  user: { login: 'tanaabot', nodeId: 'U_agent', type: 'User' },
                });
              }
              return response([]);
            },
          };
        },
      },
      authority: { inspect: async () => ({ authorized: true }) },
      leaseStore: leaseStore(scopes),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      sessions: {
        async generateAcknowledgment() {
          generations += 1;
          return "Gladly — I've got this one.";
        },
      },
      stateStore: store,
    });

    service.start('tanaabot');
    service.schedule('tanaabot', notificationItemKey);
    await service.settle();

    assert.equal(generations, 1);
    assert.deepEqual(scopes, ['acknowledgment', 'cycle']);
    assert.equal(requests.filter(({ argv }) => argv.includes('POST')).length, 1);
    assert.match(
      requests.find(({ argv }) => argv.includes('POST'))?.stdin ?? '',
      /agent-system-github-assignment-ack/u,
    );
    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.acknowledgment, {
      commentId: 91,
      status: 'published',
    });
    assert.equal(store.state().items[notificationItemKey]?.delivery?.failureCode, undefined);
  });

  it('should adopt an existing own marker without generating or posting again', async () => {
    const store = memoryStore();
    let generations = 0;
    let posts = 0;
    const service = new GitHubNotificationAcknowledgmentService({
      accountClient: {
        async connect() {
          return {
            identity: { login: 'tanaabot', nodeId: 'U_agent' },
            async execute(argv: string[]) {
              if (argv.includes('POST')) posts += 1;
              return response([
                {
                  databaseId: 91,
                  nodeId: 'IC_existing',
                  user: { login: 'tanaabot', nodeId: 'U_agent', type: 'User' },
                },
              ]);
            },
          };
        },
      },
      authority: { inspect: async () => ({ authorized: true }) },
      leaseStore: leaseStore([]),
      logger: { error() {}, info() {}, warn() {} },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      sessions: {
        async generateAcknowledgment() {
          generations += 1;
          return 'On it.';
        },
      },
      stateStore: store,
    });

    service.start('tanaabot');
    service.schedule('tanaabot', notificationItemKey);
    await service.settle();

    assert.equal(generations, 0);
    assert.equal(posts, 0);
    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.acknowledgment, {
      commentId: 91,
      status: 'published',
    });
  });

  it('should keep intake active and persist a stable generation failure', async () => {
    const store = memoryStore();
    const warnings: string[] = [];
    const service = new GitHubNotificationAcknowledgmentService({
      accountClient: {
        async connect() {
          return {
            identity: { login: 'tanaabot', nodeId: 'U_agent' },
            execute: async () => response([]),
          };
        },
      },
      authority: { inspect: async () => ({ authorized: true }) },
      leaseStore: leaseStore([]),
      logger: { error() {}, info() {}, warn: (message) => warnings.push(message) },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      sessions: {
        async generateAcknowledgment() {
          throw Object.assign(new Error('unsafe output'), {
            code: 'github-notification-acknowledgment-secret-safety-rejected',
          });
        },
      },
      stateStore: store,
    });

    service.start('tanaabot');
    service.schedule('tanaabot', notificationItemKey);
    await service.settle();

    assert.equal(store.state().items[notificationItemKey]?.delivery?.stage, 'active');
    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.acknowledgment, {
      status: 'pending',
    });
    assert.equal(
      store.state().items[notificationItemKey]?.delivery?.failureCode,
      'github-notification-acknowledgment-secret-safety-rejected',
    );
    assert.deepEqual(warnings, [
      'github-notifications: acknowledgment deferred agent=tanaabot code=github-notification-acknowledgment-secret-safety-rejected',
    ]);
  });

  it('should drain pending state on gateway start and retry it after restart', async () => {
    const store = memoryStore();
    const warnings: string[] = [];
    let attempts = 0;
    const service = new GitHubNotificationAcknowledgmentService({
      accountClient: {
        async connect() {
          return {
            identity: { login: 'tanaabot', nodeId: 'U_agent' },
            async execute(argv: string[], stdin?: string) {
              if (argv.includes('POST')) {
                return response({
                  body: JSON.parse(stdin ?? '{}').body,
                  databaseId: 92,
                  nodeId: 'IC_retried',
                  user: { login: 'tanaabot', nodeId: 'U_agent', type: 'User' },
                });
              }
              return response([]);
            },
          };
        },
      },
      authority: { inspect: async () => ({ authorized: true }) },
      leaseStore: leaseStore([]),
      logger: { error() {}, info() {}, warn: (message) => warnings.push(message) },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      sessions: {
        async generateAcknowledgment() {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error('temporary failure'), {
              code: 'github-notification-acknowledgment-generation-failed',
            });
          }
          return 'I have this one.';
        },
      },
      stateStore: store,
    });

    assert.equal(service.schedule('tanaabot', notificationItemKey), 'inactive');
    assert.deepEqual(await service.drain('tanaabot'), {
      pending: 0,
      scheduled: 0,
      status: 'inactive',
    });

    service.start('tanaabot');
    assert.deepEqual(await service.drain('tanaabot'), {
      pending: 1,
      scheduled: 1,
      status: 'active',
    });
    await service.settle('tanaabot');
    assert.equal(
      store.state().items[notificationItemKey]?.delivery?.failureCode,
      'github-notification-acknowledgment-generation-failed',
    );
    await service.stop('tanaabot');

    service.start('tanaabot');
    assert.deepEqual(await service.drain('tanaabot'), {
      pending: 1,
      scheduled: 1,
      status: 'active',
    });
    await service.settle('tanaabot');

    assert.equal(attempts, 2);
    assert.deepEqual(store.state().items[notificationItemKey]?.delivery?.acknowledgment, {
      commentId: 92,
      status: 'published',
    });
    assert.equal(store.state().items[notificationItemKey]?.delivery?.failureCode, undefined);
    assert.deepEqual(warnings, [
      'github-notifications: acknowledgment deferred agent=tanaabot code=github-notification-acknowledgment-generation-failed',
    ]);
  });
});
