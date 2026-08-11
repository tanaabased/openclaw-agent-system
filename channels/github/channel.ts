import type { ChannelPlugin, OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import {
  runChannelInboundEvent,
  type InboundReplyDispatchResult,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';

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

/** Local-only channel registered for the observe-only monitor and later inbound delivery. */
export const githubNotificationChannel: ChannelPlugin<ResolvedNotificationChannelAccount> = {
  id: githubNotificationChannelId,
  meta: {
    id: githubNotificationChannelId,
    label: 'Agent System GitHub Notifications',
    selectionLabel: 'Agent System GitHub Notifications',
    docsPath:
      'https://github.com/tanaabased/openclaw-agent-system/blob/main/channels/github/README.md',
    blurb: 'Observes authorized GitHub work assignments for agent-scoped local routing.',
    exposure: { configured: true, docs: true, setup: false },
    forceAccountBinding: true,
  },
  capabilities: { chatTypes: ['direct'], blockStreaming: true },
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
  // No send adapter is registered: automated briefing replies remain local.
  message: {
    receive: {
      defaultAckPolicy: 'after_agent_dispatch',
      supportedAckPolicies: ['after_agent_dispatch'],
    },
  },
};

export interface GitHubNotificationAssignmentEvent {
  id: string;
  itemNumber: number;
  itemType: 'issue' | 'pull-request';
  repositoryId: string;
  timestamp?: number;
  title: string;
}

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
  prepareTurn(
    event: GitHubNotificationAssignmentEvent,
    route: ResolvedNotificationRoute,
  ): PreparedInboundReply<TDispatchResult>;
}

/** Run one authorized synthetic assignment through OpenClaw's channel inbound kernel. */
export async function runGitHubNotificationAssignment<TDispatchResult>(
  event: GitHubNotificationAssignmentEvent,
  dependencies: GitHubNotificationInboundDependencies<TDispatchResult>,
): Promise<InboundReplyDispatchResult<TDispatchResult>> {
  const conversationId = githubNotificationConversationId(event);
  return runChannelInboundEvent({
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
      preflight: () => ({ kind: 'dispatch', reason: 'authorized-github-assignment' }),
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
}
