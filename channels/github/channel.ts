import type { ChannelPlugin, OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import type { ChannelAccountSnapshot } from 'openclaw/plugin-sdk/status-helpers';
import { buildJsonChannelConfigSchema } from 'openclaw/plugin-sdk/channel-config-schema';

import {
  githubChannelAccounts,
  githubChannelId,
  ownsGitHubChannelAccount,
  wantsGitHubChannel,
} from './channel-config.ts';
import {
  githubNotificationRuntimeBlocker,
  githubNotificationRuntimeDiagnostics,
} from './notification-policy.ts';
import type AgentManifestService from '../../manifest/service.ts';
import type OpenClawIntake from '../../agent/openclaw-intake.ts';
import type { AgentManifest } from '../../manifest/types.ts';
import { githubChannelMetadata, githubChannelSchema } from './channel-schema.ts';

interface Account {
  accountId: string;
  enabled: boolean;
}
interface Dependencies {
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  intake: Pick<OpenClawIntake, 'inspect'>;
  automationReadiness(manifest: AgentManifest, workspace: string): Promise<string | undefined>;
  now?(): number;
}

export default function createGitHubStatusChannel(
  dependencies: Dependencies,
): ChannelPlugin<Account> {
  const resolveAccount = (config: OpenClawConfig, accountId?: string | null): Account => {
    const accounts = githubChannelAccounts(config);
    const id =
      accountId ??
      Object.keys(accounts).find((id) => accounts[id]?.enabled) ??
      Object.keys(accounts)[0] ??
      'default';
    return { accountId: id, enabled: githubChannelAccounts(config)[id]?.enabled ?? false };
  };
  async function snapshot(
    account: Account,
    config: OpenClawConfig,
  ): Promise<ChannelAccountSnapshot> {
    const base = { ...account, name: account.accountId, configured: true, mode: 'readiness' };
    const result = (
      state: string,
      code?: string,
      fields: Partial<ChannelAccountSnapshot> = {},
    ): ChannelAccountSnapshot => ({
      ...base,
      statusState: state,
      stateReason: code ?? state,
      lifecycle:
        state === 'inactive'
          ? 'stopped'
          : ['healthy', 'awaiting-first-scan'].includes(state)
            ? 'ready'
            : 'blocked',
      running: ['healthy', 'awaiting-first-scan'].includes(state),
      lastError: code ?? null,
      ...fields,
    });
    try {
      const loaded = await dependencies.manifestService.loadForAgentId(
        account.accountId,
        'service',
      );
      if (loaded.status !== 'loaded')
        return result(
          account.enabled ? 'setup-required' : 'inactive',
          account.enabled ? 'github-channel-manifest-unavailable' : undefined,
          {
            configured: false,
          },
        );
      const desired = wantsGitHubChannel(loaded.manifest);
      if (desired !== account.enabled)
        return result('sync-required', 'github-channel-sync-required');
      if (!desired) return result('inactive');
      if (!ownsGitHubChannelAccount(config, account.accountId, loaded.scope.workspaceDir))
        return result('blocked', 'github-channel-ownership-conflict');
      const blocker = githubNotificationRuntimeBlocker(
        loaded.manifest.github?.notifications,
        'openclaw',
      );
      if (blocker) return result('blocked', blocker.code);
      const intake = await dependencies.intake.inspect(loaded.manifest, loaded.scope.workspaceDir);
      if (intake.code)
        return result(
          ['intake-policy-reconciliation-required', 'intake-automation-update-required'].includes(
            intake.code,
          )
            ? 'sync-required'
            : intake.code === 'intake-activation-required'
              ? 'setup-required'
              : 'blocked',
          intake.code,
        );
      const automation = await dependencies.automationReadiness(
        loaded.manifest,
        loaded.scope.workspaceDir,
      );
      const fields = { lastInboundAt: intake.checkpoint ?? null };
      if (automation)
        return result(
          ['automation-sync-required', 'intake-automation-update-required'].includes(automation)
            ? 'sync-required'
            : automation === 'intake-activation-required'
              ? 'setup-required'
              : automation === 'automation-observation-unavailable'
                ? 'unknown'
                : 'degraded',
          automation,
          fields,
        );
      const warnings = githubNotificationRuntimeDiagnostics(
        loaded.manifest.github?.notifications,
        'openclaw',
      ).filter(({ status }) => status === 'warning');
      if (!intake.checkpoint && !warnings.length) return result('awaiting-first-scan');
      const policy = loaded.manifest.github!.notifications!;
      const interval = policy.schemaVersion === 2 ? policy.intervalMinutes : 5;
      if (
        intake.checkpoint &&
        (dependencies.now?.() ?? Date.now()) - intake.checkpoint > interval * 60_000 * 3
      )
        return result('degraded', 'intake-scan-overdue', fields);
      if (warnings.length)
        return result('degraded', 'github-notification-capabilities-degraded', {
          ...fields,
          lifecycle: 'ready',
          running: true,
          lastError: warnings.map(({ message }) => message).join(' '),
        });
      return result('healthy', undefined, fields);
    } catch {
      return result('unknown', 'github-channel-inspection-unavailable');
    }
  }
  return {
    id: githubChannelId,
    meta: githubChannelMetadata,
    configSchema: buildJsonChannelConfigSchema(githubChannelSchema),
    capabilities: { chatTypes: ['direct'], blockStreaming: true },
    reload: { configPrefixes: [`channels.${githubChannelId}`] },
    config: {
      listAccountIds: (config) => Object.keys(githubChannelAccounts(config)),
      resolveAccount,
      defaultAccountId: (config) => resolveAccount(config).accountId,
      isEnabled: (account) => account.enabled,
      isConfigured: (account, config) => Boolean(githubChannelAccounts(config)[account.accountId]),
      describeAccount: (account) => ({ ...account, name: account.accountId }),
    },
    status: {
      buildAccountSnapshot: ({ account, cfg }) => snapshot(account, cfg),
      buildChannelSummary: ({ snapshot }) => ({ ...snapshot, mode: 'readiness' }),
      collectStatusIssues: (accounts) =>
        accounts
          .filter(({ lastError }) => lastError)
          .map((account) => ({
            channel: githubChannelId,
            accountId: account.accountId,
            kind: 'config',
            message: account.lastError!,
            fix:
              account.statusState === 'sync-required' || account.statusState === 'setup-required'
                ? 'Run Agent System Install for this agent.'
                : 'Inspect Agent System Doctor and notification status for this agent.',
          })),
    },
  };
}
