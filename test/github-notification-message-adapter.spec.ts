import assert from 'node:assert/strict';

import { verifyChannelMessageAdapterCapabilityProofs } from 'openclaw/plugin-sdk/channel-outbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { createGitHubNotificationMessageAdapter } from '../channels/github/lib/message-adapter.ts';
import { githubNotificationPublicationTarget } from '../channels/github/utils/publication.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import type { AgentSystemCliResult } from '../lib/tool-types.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import {
  notificationAccount,
  notificationItemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

const config: OpenClawConfig = {
  agents: { list: [{ id: 'tanaabot', workspace: '/workspace' }] },
  bindings: [
    {
      type: 'route',
      agentId: 'tanaabot',
      match: { accountId: 'tanaabot', channel: 'agent-system-github' },
      session: { dmScope: 'per-account-channel-peer' },
    },
  ],
  channels: { 'agent-system-github': { accounts: { tanaabot: { enabled: true } } } },
};
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
  const item = state.items[notificationItemKey]!;
  item.delivery = {
    ...item.delivery!,
    sessionKey: 'agent:tanaabot:agent-system-github:tanaabot:direct:github:item',
    stage: 'active',
    worktreeBranch: 'agent/tanaabot/issue-7',
    worktreePath: '/workspace/.agent-system/worktrees/issue-7',
  };
  return state;
}

function target(state = activeState()): string {
  const item = state.items[notificationItemKey]!;
  return githubNotificationPublicationTarget({
    intent: 'initial-acknowledgment',
    item,
    publicationId: item.delivery!.assignmentEventId,
  });
}

function loadedManifest() {
  return {
    diagnostics: [],
    digest: 'digest',
    manifest,
    path: '/workspace/agent.yaml',
    scope: { agentId: 'tanaabot', workspaceDir: '/workspace' },
    status: 'loaded' as const,
    validationChecks: [],
  };
}

describe('channels/github/lib/message-adapter', () => {
  it('should prove only text and unknown-send reconciliation capabilities', async () => {
    const adapter = createGitHubNotificationMessageAdapter({
      accountClient: { connect: async () => Promise.reject(new Error('not used')) },
      authority: { inspect: async () => ({ authorized: false }) },
      leaseStore: { acquire: async () => ({ status: 'busy' }) },
      manifestService: { loadForAgentId: async () => Promise.reject(new Error('not used')) },
      stateStore: { read: async () => undefined },
    });

    const results = await verifyChannelMessageAdapterCapabilityProofs({
      adapter,
      adapterName: 'agent-system-github',
      proofs: {
        reconcileUnknownSend() {
          assert.equal(typeof adapter.durableFinal?.reconcileUnknownSend, 'function');
        },
        text() {
          assert.equal(typeof adapter.send?.text, 'function');
        },
      },
    });

    assert.deepEqual(
      results.filter(({ status }) => status === 'verified'),
      [
        { capability: 'text', status: 'verified' },
        { capability: 'reconcileUnknownSend', status: 'verified' },
      ],
    );
    assert.equal(
      results.every(({ capability, status }) =>
        capability === 'text' || capability === 'reconcileUnknownSend'
          ? status === 'verified'
          : status === 'not_declared',
      ),
      true,
    );
  });

  it('should reauthorize and publish one marked comment through the exact account target', async () => {
    const state = activeState();
    const order: string[] = [];
    const requests: Array<{ argv: string[]; stdin?: string }> = [];
    const adapter = createGitHubNotificationMessageAdapter({
      accountClient: {
        async connect() {
          order.push('credentials');
          return {
            identity: notificationAccount,
            async execute(argv, stdin) {
              requests.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
              if (!argv.includes('POST')) return response([]);
              const body = String(JSON.parse(stdin ?? '{}').body);
              return response({
                body,
                databaseId: 91,
                nodeId: 'IC_published',
                user: notificationAccount,
              });
            },
          };
        },
      },
      authority: {
        async inspect() {
          order.push('authority');
          return { authorized: true };
        },
      },
      leaseStore: {
        async acquire() {
          order.push('lease');
          return { lease: { async release() {} }, status: 'acquired' as const };
        },
      },
      manifestService: {
        async loadForAgentId() {
          order.push('manifest');
          return loadedManifest();
        },
      },
      stateStore: {
        async read() {
          order.push('state');
          return structuredClone(state);
        },
      },
    });

    const result = await adapter.send!.text!({
      accountId: 'tanaabot',
      cfg: config,
      text: 'I have this one.',
      to: target(state),
    });

    assert.deepEqual(order, ['lease', 'state', 'manifest', 'authority', 'credentials']);
    assert.equal(result.messageId, '91');
    assert.deepEqual(result.receipt.platformMessageIds, ['91']);
    assert.equal(requests.length, 2);
    assert.match(requests[1]?.stdin ?? '', /agent-system-github-publication/u);
    assert.equal(
      requests[1]?.argv.some((value) => value.includes('I have this one.')),
      false,
    );
  });

  it('should adopt an existing own marker instead of posting twice', async () => {
    let posts = 0;
    const state = activeState();
    const adapter = createGitHubNotificationMessageAdapter({
      accountClient: {
        async connect() {
          return {
            identity: notificationAccount,
            async execute(argv) {
              if (argv.includes('POST')) posts += 1;
              return response([
                {
                  databaseId: 91,
                  nodeId: 'IC_existing',
                  user: notificationAccount,
                },
              ]);
            },
          };
        },
      },
      authority: { inspect: async () => ({ authorized: true }) },
      leaseStore: {
        acquire: async () => ({ lease: { async release() {} }, status: 'acquired' as const }),
      },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      stateStore: { read: async () => structuredClone(state) },
    });

    const result = await adapter.send!.text!({
      accountId: 'tanaabot',
      cfg: config,
      text: 'I have this one.',
      to: target(state),
    });

    assert.equal(result.messageId, '91');
    assert.equal(posts, 0);
  });

  it('should fail before credentials when the target or current authority is invalid', async () => {
    const state = activeState();
    let credentials = 0;
    const adapter = createGitHubNotificationMessageAdapter({
      accountClient: {
        async connect() {
          credentials += 1;
          throw new Error('must not connect');
        },
      },
      authority: { inspect: async () => ({ authorized: false }) },
      leaseStore: {
        acquire: async () => ({ lease: { async release() {} }, status: 'acquired' as const }),
      },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      stateStore: { read: async () => structuredClone(state) },
    });

    await assert.rejects(
      adapter.send!.text!({
        accountId: 'tanaabot',
        cfg: config,
        text: 'I have this one.',
        to: target(state),
      }),
      /could not be delivered/u,
    );
    await assert.rejects(
      adapter.send!.text!({
        accountId: 'tanaabot',
        cfg: config,
        text: 'I have this one.',
        to: 'github:R_repo:12',
      }),
      /targets are invalid/u,
    );
    assert.equal(credentials, 0);
  });

  it('should reconcile an unknown send from its provider marker', async () => {
    const state = activeState();
    const adapter = createGitHubNotificationMessageAdapter({
      accountClient: {
        async connect() {
          return {
            identity: notificationAccount,
            execute: async () =>
              response([
                {
                  databaseId: 91,
                  nodeId: 'IC_existing',
                  user: notificationAccount,
                },
              ]),
          };
        },
      },
      authority: { inspect: async () => ({ authorized: true }) },
      leaseStore: {
        acquire: async () => ({ lease: { async release() {} }, status: 'acquired' as const }),
      },
      manifestService: { loadForAgentId: async () => loadedManifest() },
      stateStore: { read: async () => structuredClone(state) },
    });

    const result = await adapter.durableFinal!.reconcileUnknownSend!({
      accountId: 'tanaabot',
      cfg: config,
      channel: 'agent-system-github',
      enqueuedAt: 1,
      payloads: [{ text: 'I have this one.' }],
      queueId: 'queue-1',
      retryCount: 1,
      to: target(state),
    });

    assert.equal(result?.status, 'sent');
    if (result?.status === 'sent') assert.equal(result.messageId, '91');
  });
});
