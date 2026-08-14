import type { ChannelPlugin, OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { recordChannelActivity } from 'openclaw/plugin-sdk/channel-activity-runtime';
import type { ChannelMessageAdapter } from 'openclaw/plugin-sdk/channel-outbound';
import {
  runChannelInboundEvent,
  type InboundReplyDispatchResult,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import { createAccountStatusSink } from 'openclaw/plugin-sdk/channel-lifecycle';
import {
  createAsyncComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from 'openclaw/plugin-sdk/status-helpers';

import type GitHubNotificationMonitorService from './lib/monitor-service.ts';
import type GitHubNotificationMonitorStateStore from './lib/monitor-state-store.ts';
import type GitHubNotificationActivationService from './lib/activation-service.ts';
import type { GitHubNotificationMonitorState } from './utils/monitor-state.ts';
import {
  githubNotificationChannelId,
  resolveNotificationRoute,
  type NotificationRoutingDesiredState,
  type ResolvedNotificationRoute,
} from './utils/routing.ts';

interface ResolvedNotificationChannelAccount {
  accountId: string;
  enabled: boolean;
}

export interface GitHubNotificationChannelDependencies {
  activationService: Pick<GitHubNotificationActivationService, 'schedule' | 'settle'>;
  clock?: () => number;
  message: ChannelMessageAdapter;
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
      blurb: 'Routes authorized GitHub work assignments into agent-scoped local sessions.',
      exposure: { configured: true, docs: true, setup: false },
      forceAccountBinding: true,
    },
    capabilities: { chatTypes: ['direct'], blockStreaming: true },
    message: dependencies.message,
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
        dependencies.activationService.schedule(context.accountId, context.abortSignal);
        try {
          await dependencies.monitorService.runAccount(
            context.accountId,
            context.abortSignal,
            async () => {
              dependencies.activationService.schedule(context.accountId, context.abortSignal);
              await publish();
            },
          );
        } finally {
          await dependencies.activationService.settle(context.accountId);
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
  repositoryId: string;
  timestamp?: number;
  title: string;
}

export type GitHubNotificationInboundTurn<TDispatchResult = never> =
  PreparedInboundReply<TDispatchResult>;

export function githubNotificationConversationId(
  event: Pick<GitHubNotificationAssignmentEvent, 'itemNumber' | 'repositoryId'>,
): string {
  if (!Number.isSafeInteger(event.itemNumber) || event.itemNumber < 1) {
    throw new Error('GitHub notification item numbers must be positive safe integers.');
  }
  const repositoryId = event.repositoryId.trim();
  if (!repositoryId) throw new Error('GitHub notification repository ids must not be empty.');
  return `github:${encodeURIComponent(repositoryId)}:${event.itemNumber}`;
}

export interface GitHubNotificationInboundDependencies<TDispatchResult> {
  config: OpenClawConfig;
  desired: NotificationRoutingDesiredState;
  recordActivity?: typeof recordChannelActivity;
  prepareTurn(
    event: GitHubNotificationAssignmentEvent,
    route: ResolvedNotificationRoute,
  ): GitHubNotificationInboundTurn<TDispatchResult>;
}

/** Record one authorized assignment through OpenClaw's channel inbound kernel. */
export async function runGitHubNotificationAssignment<TDispatchResult>(
  event: GitHubNotificationAssignmentEvent,
  dependencies: GitHubNotificationInboundDependencies<TDispatchResult>,
): Promise<InboundReplyDispatchResult<TDispatchResult>> {
  const conversationId = githubNotificationConversationId(event);
  const result = await runChannelInboundEvent({
    channel: githubNotificationChannelId,
    accountId: dependencies.desired.agentId,
    raw: event,
    adapter: {
      ingest(raw) {
        return {
          id: raw.id,
          timestamp: raw.timestamp,
          rawText: raw.title,
          textForAgent: raw.title,
          raw,
        };
      },
      classify: () => ({ kind: 'message', canStartAgentTurn: true }),
      preflight: () => ({ kind: 'observeOnly', reason: 'authorized-github-assignment' }),
      resolveTurn() {
        const route = resolveNotificationRoute(
          dependencies.config,
          dependencies.desired,
          conversationId,
        );
        return {
          ...dependencies.prepareTurn(event, route),
          channel: githubNotificationChannelId,
          accountId: route.accountId,
          routeSessionKey: route.sessionKey,
        };
      },
    },
  });
  if (result.dispatched && result.admission.kind === 'observeOnly') {
    (dependencies.recordActivity ?? recordChannelActivity)({
      accountId: dependencies.desired.agentId,
      channel: githubNotificationChannelId,
      direction: 'inbound',
    });
  }
  return result;
}
