import { resolve } from 'node:path';

import { listAgentEntries, resolveAgentWorkspaceDir } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';
import { resolveAgentRoute } from 'openclaw/plugin-sdk/routing';

export const githubNotificationChannelId = 'agent-system-github';
export const githubNotificationBindingComment = 'managed by agent system github notifications';

export interface NotificationRoutingDesiredState {
  agentId: string;
  enabled: boolean;
  workspaceDir: string;
}

export interface NotificationRoutingReceipt {
  accountId: string;
  agentId: string;
  channelId: typeof githubNotificationChannelId;
  schemaVersion: 1;
  workspaceDir: string;
}

export type NotificationRoutingPlan =
  | {
      code: string;
      kind: 'adopt' | 'forget' | 'noop' | 'remove' | 'upsert';
      message: string;
    }
  | {
      code: string;
      kind: 'conflict';
      message: string;
    };

export interface ResolvedNotificationRoute {
  accountId: string;
  agentId: string;
  channel: typeof githubNotificationChannelId;
  conversationId: string;
  matchedBy: 'binding.account';
  sessionKey: string;
  workspaceDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizedAgentId(agentId: string): string {
  return agentId.trim().toLowerCase();
}

function receiptMatches(
  receipt: NotificationRoutingReceipt,
  desired: NotificationRoutingDesiredState,
): boolean {
  return (
    receipt.schemaVersion === 1 &&
    receipt.channelId === githubNotificationChannelId &&
    receipt.accountId === normalizedAgentId(desired.agentId) &&
    receipt.agentId === normalizedAgentId(desired.agentId) &&
    resolve(receipt.workspaceDir) === resolve(desired.workspaceDir)
  );
}

function accountState(
  config: OpenClawConfig,
  accountId: string,
): 'absent' | 'exact' | 'invalid' | 'repairable' {
  const section = config.channels?.[githubNotificationChannelId] as unknown;
  if (section === undefined) return 'absent';
  if (!isRecord(section)) return 'invalid';
  const accounts = section.accounts;
  if (accounts === undefined) return 'absent';
  if (!isRecord(accounts)) return 'invalid';
  const account = accounts[accountId];
  if (account === undefined) return 'absent';
  if (!isRecord(account)) return 'invalid';
  if (Object.keys(account).some((key) => key !== 'enabled')) return 'invalid';
  if (account.enabled !== undefined && typeof account.enabled !== 'boolean') return 'invalid';
  return account.enabled === true ? 'exact' : 'repairable';
}

function exactAccountBindings(config: OpenClawConfig, accountId: string) {
  return (config.bindings ?? []).filter(
    (binding) =>
      binding.match.channel === githubNotificationChannelId &&
      binding.match.accountId === accountId &&
      binding.match.peer === undefined &&
      binding.match.guildId === undefined &&
      binding.match.teamId === undefined &&
      binding.match.roles === undefined,
  );
}

function bindingIsExpected(
  binding: NonNullable<OpenClawConfig['bindings']>[number],
  accountId: string,
): boolean {
  return (
    binding.type !== 'acp' &&
    normalizedAgentId(binding.agentId) === accountId &&
    binding.session?.dmScope === 'per-account-channel-peer'
  );
}

function configuredAgentWorkspace(config: OpenClawConfig, agentId: string): string | undefined {
  const entries = listAgentEntries(config);
  const entry = entries.find(({ id }) => normalizedAgentId(id) === agentId);
  if (!entry && !(entries.length === 0 && agentId === 'main')) return undefined;
  return resolveAgentWorkspaceDir(config, agentId);
}

function conflict(code: string, message: string): NotificationRoutingPlan {
  return { code, kind: 'conflict', message };
}

/** Compare one manifest-owned GitHub notification route with global OpenClaw state. */
export function planNotificationRouting(
  config: OpenClawConfig,
  desired: NotificationRoutingDesiredState,
  receipt?: NotificationRoutingReceipt,
): NotificationRoutingPlan {
  const agentId = normalizedAgentId(desired.agentId);
  if (receipt && !receiptMatches(receipt, desired)) {
    return conflict(
      'notification-routing-receipt-conflict',
      'The stored notification routing receipt belongs to different agent or workspace state.',
    );
  }

  if (!desired.enabled && !receipt) {
    return {
      code: 'notification-routing-disabled',
      kind: 'noop',
      message: 'GitHub notification routing is not enabled or owned for this agent.',
    };
  }

  if (desired.enabled) {
    const workspaceDir = configuredAgentWorkspace(config, agentId);
    if (!workspaceDir) {
      return conflict(
        'notification-routing-agent-missing',
        `OpenClaw agent ${agentId} is unavailable for notification routing.`,
      );
    }
    if (resolve(workspaceDir) !== resolve(desired.workspaceDir)) {
      return conflict(
        'notification-routing-workspace-conflict',
        `OpenClaw agent ${agentId} resolves to a different workspace.`,
      );
    }
  }

  const account = accountState(config, agentId);
  if (account === 'invalid') {
    return conflict(
      'notification-routing-account-conflict',
      `The ${githubNotificationChannelId} account ${agentId} contains unsupported or invalid state.`,
    );
  }
  const bindings = exactAccountBindings(config, agentId);
  if (bindings.length > 1) {
    return conflict(
      'notification-routing-binding-duplicate',
      `Multiple exact ${githubNotificationChannelId}:${agentId} bindings are configured.`,
    );
  }
  const binding = bindings[0];
  const bindingExpected = binding ? bindingIsExpected(binding, agentId) : false;
  if (binding && normalizedAgentId(binding.agentId) !== agentId) {
    return conflict(
      'notification-routing-binding-conflict',
      `The ${githubNotificationChannelId}:${agentId} binding selects another agent.`,
    );
  }

  if (!desired.enabled) {
    if (binding && !bindingExpected) {
      return conflict(
        'notification-routing-binding-changed',
        `The owned ${githubNotificationChannelId}:${agentId} binding was changed outside Agent System.`,
      );
    }
    if (account === 'repairable') {
      return conflict(
        'notification-routing-account-changed',
        `The owned ${githubNotificationChannelId} account ${agentId} was changed outside Agent System.`,
      );
    }
    if (account === 'absent' && !binding) {
      return {
        code: 'notification-routing-receipt-stale',
        kind: 'forget',
        message: 'The notification routing projection is absent but its receipt remains.',
      };
    }
    return {
      code: 'notification-routing-removal-required',
      kind: 'remove',
      message: 'The owned GitHub notification account and binding should be removed.',
    };
  }

  if (!receipt) {
    if (account === 'absent' && !binding) {
      return {
        code: 'notification-routing-install-required',
        kind: 'upsert',
        message: 'The GitHub notification account and binding are not installed.',
      };
    }
    if (account === 'exact' && bindingExpected) {
      return {
        code: 'notification-routing-receipt-required',
        kind: 'adopt',
        message: 'The exact notification route exists but has no Agent System receipt.',
      };
    }
    return conflict(
      'notification-routing-unowned-state',
      `Partial unowned state already exists for ${githubNotificationChannelId}:${agentId}.`,
    );
  }

  if (account === 'exact' && bindingExpected) {
    return {
      code: 'notification-routing-ready',
      kind: 'noop',
      message: 'The GitHub notification account and exact agent binding match.',
    };
  }
  return {
    code: 'notification-routing-repair-required',
    kind: 'upsert',
    message: 'The owned GitHub notification account or binding has drifted.',
  };
}

export function createNotificationRoutingReceipt(
  desired: NotificationRoutingDesiredState,
): NotificationRoutingReceipt {
  const agentId = normalizedAgentId(desired.agentId);
  return {
    schemaVersion: 1,
    accountId: agentId,
    agentId,
    channelId: githubNotificationChannelId,
    workspaceDir: resolve(desired.workspaceDir),
  };
}

function expectedBinding(accountId: string): NonNullable<OpenClawConfig['bindings']>[number] {
  return {
    type: 'route',
    agentId: accountId,
    comment: githubNotificationBindingComment,
    match: { channel: githubNotificationChannelId, accountId },
    session: { dmScope: 'per-account-channel-peer' },
  };
}

/** Apply a previously computed safe routing mutation while preserving unrelated state. */
export function applyNotificationRoutingPlan(
  config: OpenClawConfig,
  desired: NotificationRoutingDesiredState,
  plan: NotificationRoutingPlan,
): boolean {
  if (plan.kind === 'conflict') throw new Error(plan.message);
  if (plan.kind !== 'remove' && plan.kind !== 'upsert') return false;
  const accountId = normalizedAgentId(desired.agentId);

  if (plan.kind === 'upsert') {
    config.channels ??= {};
    const existingSection = config.channels[githubNotificationChannelId] as unknown;
    const section = isRecord(existingSection) ? existingSection : {};
    const existingAccounts = section.accounts;
    const accounts = isRecord(existingAccounts) ? existingAccounts : {};
    accounts[accountId] = { enabled: true };
    section.accounts = accounts;
    config.channels[githubNotificationChannelId] = section;

    config.bindings ??= [];
    const bindingIndex = config.bindings.findIndex(
      (binding) =>
        binding.match.channel === githubNotificationChannelId &&
        binding.match.accountId === accountId &&
        binding.match.peer === undefined &&
        binding.match.guildId === undefined &&
        binding.match.teamId === undefined &&
        binding.match.roles === undefined,
    );
    if (bindingIndex === -1) config.bindings.push(expectedBinding(accountId));
    else config.bindings[bindingIndex] = expectedBinding(accountId);
    return true;
  }

  const section = config.channels?.[githubNotificationChannelId] as unknown;
  if (isRecord(section) && isRecord(section.accounts)) {
    delete section.accounts[accountId];
    if (Object.keys(section.accounts).length === 0) delete section.accounts;
    if (Object.keys(section).length === 0 && config.channels) {
      delete config.channels[githubNotificationChannelId];
    }
  }
  if (config.bindings) {
    config.bindings = config.bindings.filter(
      (binding) =>
        !(
          binding.match.channel === githubNotificationChannelId &&
          binding.match.accountId === accountId &&
          binding.match.peer === undefined &&
          binding.match.guildId === undefined &&
          binding.match.teamId === undefined &&
          binding.match.roles === undefined
        ),
    );
    if (config.bindings.length === 0) delete config.bindings;
  }
  if (config.channels && Object.keys(config.channels).length === 0) delete config.channels;
  return true;
}

/** Resolve one deterministic work-item conversation without permitting default routing. */
export function resolveNotificationRoute(
  config: OpenClawConfig,
  desired: NotificationRoutingDesiredState,
  conversationId: string,
): ResolvedNotificationRoute {
  const accountId = normalizedAgentId(desired.agentId);
  if (!desired.enabled) throw new Error('GitHub notifications are disabled for this agent.');
  if (accountState(config, accountId) !== 'exact') {
    throw new Error(`The ${githubNotificationChannelId} account ${accountId} is not enabled.`);
  }
  const bindings = exactAccountBindings(config, accountId);
  if (bindings.length !== 1 || !bindingIsExpected(bindings[0]!, accountId)) {
    throw new Error(
      `The exact ${githubNotificationChannelId}:${accountId} binding does not select the expected agent.`,
    );
  }
  const workspaceDir = configuredAgentWorkspace(config, accountId);
  if (!workspaceDir || resolve(workspaceDir) !== resolve(desired.workspaceDir)) {
    throw new Error(`OpenClaw agent ${accountId} does not resolve to the expected workspace.`);
  }
  const route = resolveAgentRoute({
    cfg: config,
    channel: githubNotificationChannelId,
    accountId,
    peer: { kind: 'direct', id: conversationId },
  });
  if (
    route.matchedBy !== 'binding.account' ||
    normalizedAgentId(route.agentId) !== accountId ||
    route.accountId !== accountId
  ) {
    throw new Error(
      `The exact ${githubNotificationChannelId}:${accountId} binding does not select the expected agent.`,
    );
  }
  return {
    channel: githubNotificationChannelId,
    accountId,
    agentId: accountId,
    conversationId,
    matchedBy: 'binding.account',
    sessionKey: route.sessionKey,
    workspaceDir: resolve(workspaceDir),
  };
}
