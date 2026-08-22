import type { ChannelPlugin, OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import type { ChannelMessageAdapterShape } from 'openclaw/plugin-sdk/channel-outbound';
import { createAccountStatusSink } from 'openclaw/plugin-sdk/channel-lifecycle';
import {
  createAsyncComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from 'openclaw/plugin-sdk/status-helpers';

import type GitHubNotificationMonitorService from './intake/monitor/service.ts';
import type GitHubNotificationMonitorStateStore from './intake/monitor/state-store.ts';
import type { GitHubNotificationMonitorState } from './intake/monitor/state.ts';
import { githubNotificationChannelId } from './routing/routing.ts';

interface ResolvedNotificationChannelAccount {
  accountId: string;
  enabled: boolean;
}

export interface GitHubNotificationChannelDependencies {
  clock?: () => number;
  message?: ChannelMessageAdapterShape;
  monitorService: Pick<GitHubNotificationMonitorService, 'runAccount'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read'>;
}

function channelSection(config: OpenClawConfig): Record<string, unknown> | undefined {
  const value = config.channels?.[githubNotificationChannelId] as unknown;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function channelAccounts(config: OpenClawConfig): Record<string, unknown> {
  const accounts = channelSection(config)?.accounts;
  return accounts && typeof accounts === 'object' && !Array.isArray(accounts)
    ? (accounts as Record<string, unknown>)
    : {};
}

function resolveAccount(
  config: OpenClawConfig,
  accountId?: string | null,
): ResolvedNotificationChannelAccount {
  const normalizedAccountId = accountId?.trim().toLowerCase() ?? '';
  const account = channelAccounts(config)[normalizedAccountId];
  const enabled = Boolean(
    account &&
    typeof account === 'object' &&
    !Array.isArray(account) &&
    (account as Record<string, unknown>).enabled === true,
  );
  return { accountId: normalizedAccountId, enabled };
}

function monitorObservation(state: GitHubNotificationMonitorState | undefined) {
  return {
    lastConnectedAt: state?.lastSuccessfulPollAt ?? null,
    lastError: state?.diagnosticCode ?? null,
    lastEventAt: state?.lastSuccessfulPollAt ?? null,
    mode: 'polling',
  };
}

function monitorRuntimeStatus(state: GitHubNotificationMonitorState | undefined) {
  const connected =
    state?.baselineAt !== undefined &&
    state.lastSuccessfulPollAt !== undefined &&
    state.diagnosticCode === undefined;
  return {
    ...monitorObservation(state),
    connected,
    healthState: state?.diagnosticCode ? 'degraded' : connected ? 'healthy' : 'starting',
  };
}

/** Create the local-only channel that owns each configured account's polling lifecycle. */
export function createGitHubNotificationChannel(
  dependencies: GitHubNotificationChannelDependencies,
): ChannelPlugin<ResolvedNotificationChannelAccount> {
  const clock = dependencies.clock ?? Date.now;
  return {
    id: githubNotificationChannelId,
    meta: {
      id: githubNotificationChannelId,
      label: 'Agent System GitHub Notifications',
      selectionLabel: 'Agent System GitHub Notifications',
      docsPath:
        'https://github.com/tanaabased/openclaw-agent-system/blob/main/channels/github/README.md',
      blurb: 'Admits authorized GitHub assignments and relays approved issue comments.',
      exposure: { configured: true, docs: true, setup: false },
      forceAccountBinding: true,
    },
    capabilities: { chatTypes: ['direct'], blockStreaming: true },
    ...(dependencies.message === undefined ? {} : { message: dependencies.message }),
    reload: { configPrefixes: [`channels.${githubNotificationChannelId}`] },
    config: {
      listAccountIds(config) {
        return Object.keys(channelAccounts(config)).sort();
      },
      resolveAccount,
      inspectAccount(config, accountId) {
        const account = resolveAccount(config, accountId);
        return {
          accountId: account.accountId,
          configured: account.enabled,
          enabled: account.enabled,
        };
      },
      isConfigured: (account) => account.enabled,
      isEnabled: (account) => account.enabled,
      describeAccount: (account) => ({
        accountId: account.accountId,
        configured: account.enabled,
        enabled: account.enabled,
      }),
    },
    status: createAsyncComputedAccountStatusAdapter({
      defaultRuntime: createDefaultChannelRuntimeState('default', { mode: 'polling' }),
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot.configured ?? false,
        connected: snapshot.connected ?? false,
        running: snapshot.running ?? false,
        lastStartAt: snapshot.lastStartAt ?? null,
        lastStopAt: snapshot.lastStopAt ?? null,
        lastConnectedAt: snapshot.lastConnectedAt ?? null,
        lastError: snapshot.lastError ?? null,
        lastEventAt: snapshot.lastEventAt ?? null,
        mode: 'polling',
      }),
      async resolveAccountSnapshot({ account }) {
        return {
          accountId: account.accountId,
          enabled: account.enabled,
          configured: account.enabled,
          extra: monitorObservation(await dependencies.stateStore.read(account.accountId)),
        };
      },
    }),
    gateway: {
      async startAccount(context) {
        const status = createAccountStatusSink({
          accountId: context.accountId,
          setStatus: context.setStatus,
        });
        const publish = async (lastStartAt?: number) => {
          status({
            running: true,
            ...(lastStartAt === undefined ? {} : { lastStartAt }),
            ...monitorRuntimeStatus(await dependencies.stateStore.read(context.accountId)),
          });
        };
        await publish(clock());
        try {
          await dependencies.monitorService.runAccount(context.accountId, context.abortSignal, () =>
            publish(),
          );
        } finally {
          status({
            connected: false,
            healthState: 'stopped',
            running: false,
            lastStopAt: clock(),
          });
        }
      },
    },
  };
}

export interface GitHubNotificationAssignmentEvent {
  id: string;
  itemNumber: number;
  itemType: 'issue' | 'pull-request';
  lifecycleId: 'issue' | 'pull-request' | 'pull-request-review';
  repositoryId: string;
  timestamp?: number;
  title: string;
}

export function githubNotificationConversationId(
  event: Pick<GitHubNotificationAssignmentEvent, 'itemNumber' | 'lifecycleId' | 'repositoryId'>,
): string {
  if (!Number.isSafeInteger(event.itemNumber) || event.itemNumber < 1) {
    throw new Error('GitHub notification item numbers must be positive safe integers.');
  }
  if (!['issue', 'pull-request', 'pull-request-review'].includes(event.lifecycleId)) {
    throw new Error('GitHub notification lifecycle ids are invalid.');
  }
  const repositoryId = event.repositoryId.trim();
  if (!repositoryId) throw new Error('GitHub notification repository ids must not be empty.');
  return `github:${event.lifecycleId}:${encodeURIComponent(repositoryId)}:${event.itemNumber}`;
}
