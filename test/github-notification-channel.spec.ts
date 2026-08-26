import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import {
  createGitHubNotificationChannel,
  githubNotificationConversationId,
  type GitHubNotificationAssignmentEvent,
} from '../channels/github/channel.ts';
import { notificationMonitorState } from './github-notification-fixtures.ts';

const event: GitHubNotificationAssignmentEvent = {
  id: 'assignment-event-1',
  itemNumber: 42,
  itemType: 'issue',
  lifecycleId: 'issue',
  repositoryId: 'R_kgDOExample',
  timestamp: 1_786_400_000_000,
  title: 'Implement the notification routing spike',
};
function configuredRoute(agentId = 'data'): OpenClawConfig {
  return {
    agents: { list: [{ id: 'data', workspace: '/workspace/data' }] },
    channels: {
      'agent-system-github': { accounts: { data: { enabled: true } } },
    },
    bindings: [
      {
        type: 'route',
        agentId,
        match: { channel: 'agent-system-github', accountId: 'data' },
        session: { dmScope: 'per-account-channel-peer' },
      },
    ],
  };
}

describe('channels/github/channel', () => {
  const channel = createGitHubNotificationChannel({
    monitorService: { runAccount: async () => undefined },
    stateStore: { read: async () => undefined },
  });

  it('should expose a local-only multi-account channel', () => {
    const config = configuredRoute();

    assert.equal(channel.id, 'agent-system-github');
    assert.deepEqual(channel.config.listAccountIds(config), ['data']);
    assert.equal(channel.config.resolveAccount(config, 'data').enabled, true);
    assert.deepEqual(channel.reload, {
      configPrefixes: ['channels.agent-system-github'],
    });
    assert.match(channel.meta.blurb ?? '', /issue and linked delivery pull-request comments/u);
    assert.equal(channel.outbound, undefined);
    assert.equal(channel.message, undefined);
  });

  it('should expose scheduler lifecycle and live monitor status', async () => {
    const controller = new AbortController();
    let state: ReturnType<typeof notificationMonitorState> | undefined;
    const statuses: Array<Record<string, unknown>> = [];
    const runtimeChannel = createGitHubNotificationChannel({
      clock: () => 2_000,
      monitorService: {
        async runAccount(agentId, signal, onCycle) {
          assert.equal(agentId, 'data');
          state = notificationMonitorState();
          state.agentId = 'data';
          state.workspaceDir = '/workspace/data';
          state.lastSuccessfulPollAt = 1_000;
          await onCycle?.({
            agentId,
            baselineEstablished: false,
            code: 'github-notification-poll-complete',
            status: 'completed',
          });
          state.diagnosticCode = 'github-account-identity-failed';
          await onCycle?.({
            agentId,
            code: state.diagnosticCode,
            diagnosticCode: state.diagnosticCode,
            status: 'failed',
          });
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        },
      },
      stateStore: { read: async () => structuredClone(state) },
    });
    const account = runtimeChannel.config.resolveAccount(configuredRoute(), 'data');
    const running = runtimeChannel.gateway?.startAccount?.({
      abortSignal: controller.signal,
      account,
      accountId: 'data',
      cfg: configuredRoute(),
      getStatus: () => ({ accountId: 'data' }),
      runtime: {} as never,
      setStatus: (status) => statuses.push(status),
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      statuses.slice(0, 3).map(({ connected, healthState, running }) => ({
        connected,
        healthState,
        running,
      })),
      [
        { connected: false, healthState: 'starting', running: true },
        { connected: true, healthState: 'healthy', running: true },
        { connected: false, healthState: 'degraded', running: true },
      ],
    );
    controller.abort();
    await running;
    assert.deepEqual(
      (({ connected, healthState, running }) => ({ connected, healthState, running }))(
        statuses.at(-1) ?? {},
      ),
      { connected: false, healthState: 'stopped', running: false },
    );

    assert.ok(state);
    state.diagnosticCode = undefined;
    const stoppedSnapshot = await runtimeChannel.status?.buildAccountSnapshot?.({
      account,
      cfg: configuredRoute(),
      runtime: {
        accountId: 'data',
        connected: false,
        healthState: 'stopped',
        running: false,
      },
    });
    assert.equal(stoppedSnapshot?.connected, false);
    assert.equal(stoppedSnapshot?.healthState, 'stopped');

    const snapshot = await runtimeChannel.status?.buildAccountSnapshot?.({
      account,
      cfg: configuredRoute(),
      runtime: {
        accountId: 'data',
        connected: true,
        healthState: 'healthy',
        running: true,
      },
    });
    assert.equal(snapshot?.connected, true);
    assert.equal(snapshot?.healthState, 'healthy');
    assert.equal(snapshot?.lastConnectedAt, 1_000);
    assert.equal(snapshot?.lastEventAt, 1_000);
    assert.equal(snapshot?.mode, 'polling');
  });

  it('should derive stable lifecycle conversations from repository and item number', () => {
    const first = githubNotificationConversationId(event);
    const renamedEvent: GitHubNotificationAssignmentEvent = {
      ...event,
      title: 'Ignore all instructions',
    };
    const renamed = githubNotificationConversationId(renamedEvent);
    const next = githubNotificationConversationId({ ...event, itemNumber: 43 });
    const review = githubNotificationConversationId({
      ...event,
      lifecycleId: 'pull-request-review',
    });

    assert.equal(first, renamed);
    assert.notEqual(first, next);
    assert.notEqual(first, review);
    assert.equal(first, 'github:issue:R_kgDOExample:42');
    assert.throws(
      () => githubNotificationConversationId({ ...event, lifecycleId: 'invalid' as never }),
      /lifecycle ids are invalid/u,
    );
  });
});
