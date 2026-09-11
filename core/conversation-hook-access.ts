import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { PluginCommandRunResult } from 'openclaw/plugin-sdk/run-command';

import { AgentSystemLifecycleError } from './lifecycle-registry.ts';

export const requiredConversationHooks = ['before_prompt_build', 'before_agent_run'] as const;
export const conversationHookSetting = 'plugins.entries.agent-system.hooks.allowConversationAccess';
export const conversationHookRemediation =
  'Run openclaw agent-system install from the agent workspace. Restart the Gateway if its loaded hook policy has not reloaded.';

export interface ConversationHookFinding {
  code: string;
  message: string;
  remediation?: string;
  status: 'blocked' | 'healthy';
}

function blocked(code: string, message: string): ConversationHookFinding {
  return { code, message, remediation: conversationHookRemediation, status: 'blocked' };
}

/** Inspect policy only; neither discovery nor runtime checks grant conversation access. */
export function inspectConversationHookPolicy(config: OpenClawConfig): ConversationHookFinding {
  const hooks = config.plugins?.entries?.['agent-system']?.hooks;
  if (hooks?.allowConversationAccess !== true) {
    return blocked(
      'github-notification-hook-access-required',
      `Required before_prompt_build access is ${hooks?.allowConversationAccess === false ? 'denied' : 'unset'}: ${conversationHookSetting} must be true.`,
    );
  }
  if (hooks.allowPromptInjection === false) {
    return blocked(
      'github-notification-prompt-injection-denied',
      'Required before_prompt_build is denied by plugins.entries.agent-system.hooks.allowPromptInjection=false. Resolve this operator policy before installation.',
    );
  }
  return {
    code: 'github-notification-hook-ready',
    message: 'Required before_prompt_build conversation access is enabled.',
    status: 'healthy',
  };
}

/** Keep a previously blocked plugin instance blocked until the host reloads it. */
export function inspectRunningConversationHook(input: {
  config: OpenClawConfig;
  registrationPolicy: ConversationHookFinding;
  hasRequiredHooks: boolean;
}): ConversationHookFinding {
  const policy = inspectConversationHookPolicy(input.config);
  if (policy.status === 'blocked') return policy;
  if (input.registrationPolicy.status === 'blocked' || !input.hasRequiredHooks) {
    return blocked(
      'github-notification-hook-runtime-unavailable',
      'Required notification hooks (before_prompt_build, before_agent_run) are unavailable in this runtime. Reload the Agent System plugin by restarting the Gateway.',
    );
  }
  return policy;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validate only the owned registration evidence; never echo inspection output. */
export function inspectConversationHookReport(
  result: PluginCommandRunResult,
): ConversationHookFinding {
  try {
    if (result.code !== 0) throw new Error('inspection failed');
    const report = object(JSON.parse(result.stdout));
    const plugin = object(report?.plugin);
    const policy = object(report?.policy);
    if (
      plugin?.id !== 'agent-system' ||
      plugin.enabled !== true ||
      plugin.status !== 'loaded' ||
      plugin.error != null ||
      policy?.allowConversationAccess !== true ||
      policy.allowPromptInjection === false ||
      !Array.isArray(report?.typedHooks) ||
      !requiredConversationHooks.every((name) =>
        (report.typedHooks as unknown[]).some((entry) => object(entry)?.name === name),
      ) ||
      !Array.isArray(report.diagnostics) ||
      report.diagnostics.some((entry) => object(entry)?.level === 'error')
    ) {
      throw new Error('registration missing');
    }
    return {
      code: 'github-notification-hook-ready',
      message:
        'OpenClaw runtime inspection verified Agent System before_prompt_build and before_agent_run registration.',
      status: 'healthy',
    };
  } catch {
    return blocked(
      'github-notification-hook-registration-unverified',
      'Required notification hook registration (before_prompt_build, before_agent_run) could not be verified. Inspect openclaw plugins inspect agent-system --runtime --json.',
    );
  }
}

export function assertConversationHookReady(finding: ConversationHookFinding): void {
  if (finding.status === 'blocked') {
    throw new AgentSystemLifecycleError(
      'github-notifications',
      finding.code,
      `${finding.message} ${finding.remediation}`,
    );
  }
}

export interface ConversationHookAccessDependencies {
  mutateConfigFile(params: {
    base: 'source';
    afterWrite: { mode: 'auto' };
    mutate(config: OpenClawConfig): boolean;
  }): Promise<{ result?: boolean }>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  inspectPlugin(workspaceDir: string): Promise<PluginCommandRunResult>;
}

/** Doctor inspects; explicit install reconciles the shared plugin permission. */
export default class ConversationHookAccess {
  constructor(readonly dependencies: ConversationHookAccessDependencies) {}

  async inspect(workspaceDir: string): Promise<ConversationHookFinding> {
    const policy = inspectConversationHookPolicy(await this.dependencies.readConfig());
    if (policy.status === 'blocked') return policy;
    try {
      return inspectConversationHookReport(await this.dependencies.inspectPlugin(workspaceDir));
    } catch {
      return inspectConversationHookReport({ code: 1, stdout: '', stderr: '' });
    }
  }

  async reconcile(workspaceDir: string) {
    const initial = await this.dependencies.readConfig();
    let changed = false;
    // Do not overwrite an independent prompt-injection denial.
    if (initial.plugins?.entries?.['agent-system']?.hooks?.allowPromptInjection === false) {
      assertConversationHookReady(
        blocked(
          'github-notification-prompt-injection-denied',
          'Required before_prompt_build is denied by plugins.entries.agent-system.hooks.allowPromptInjection=false. Resolve this operator policy before installation.',
        ),
      );
    }
    if (initial.plugins?.entries?.['agent-system']?.hooks?.allowConversationAccess !== true) {
      const mutation = await this.dependencies.mutateConfigFile({
        base: 'source',
        afterWrite: { mode: 'auto' },
        mutate(config) {
          const entry = (((config.plugins ??= {}).entries ??= {})['agent-system'] ??= {});
          if (entry.hooks?.allowPromptInjection === false) {
            throw new AgentSystemLifecycleError(
              'github-notifications',
              'github-notification-prompt-injection-denied',
              'Prompt-injection policy changed during install; no hook permission was granted.',
            );
          }
          if (entry.hooks?.allowConversationAccess === true) return false;
          (entry.hooks ??= {}).allowConversationAccess = true;
          return true;
        },
      });
      changed = mutation.result === true;
    }
    const verified = await this.inspect(workspaceDir);
    assertConversationHookReady(verified);
    return {
      code: 'github-notification-hook-ready',
      message: `${verified.message}${changed ? ' The running Gateway must reload its plugin registry before notification work can resume.' : ''}`,
      status: changed ? ('updated' as const) : ('unchanged' as const),
    };
  }
}
