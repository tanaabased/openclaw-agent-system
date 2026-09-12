import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type { AgentSystemLifecycleContext } from '../../core/lifecycle-registry.ts';
import type { NotificationRoutingServiceDependencies } from './routing/service.ts';
import { initializeModelRouting } from './conversation/model-routing.ts';

const pluginId = 'agent-system';
const remediation =
  'Run openclaw agent-system install from the agent workspace. Reload the Gateway if its loaded permissions remain stale, then retry the same prepared assignment.';

type Finding = {
  code: string;
  message: string;
  remediation?: string;
  status: 'drift' | 'healthy' | 'warning';
};

export interface ModelRoutingAccessPlan {
  code: string;
  kind: 'inactive' | 'ready' | 'update';
  message: string;
  model?: string;
}

export interface GitHubModelRoutingAccessDependencies {
  mutateConfigFile: NotificationRoutingServiceDependencies['mutateConfigFile'];
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  readRuntimeConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

function allowsModel(value: unknown, model: string): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    (value.includes('*') || value.includes(model))
  );
}

function desiredModel(context: AgentSystemLifecycleContext): string | undefined {
  if (!context.manifest.github?.notifications?.assignmentTypes.includes('issue')) return undefined;
  return initializeModelRouting(context.manifest.models)?.profiles.default.model;
}

/** Plan the least additional plugin permission required by enabled issue model routing. */
export function planGitHubModelRoutingAccess(
  config: OpenClawConfig,
  context: AgentSystemLifecycleContext,
): ModelRoutingAccessPlan {
  const model = desiredModel(context);
  if (!model) {
    return {
      code: 'github-model-routing-access-inactive',
      kind: 'inactive',
      message: 'GitHub issue model routing does not require plugin LLM permissions.',
    };
  }
  const llm = config.plugins?.entries?.[pluginId]?.llm;
  const ready =
    llm?.allowAgentIdOverride === true &&
    llm.allowModelOverride === true &&
    allowsModel(llm.allowedModels, model) &&
    allowsModel(llm.allowedCompletionModels, model);
  return ready
    ? {
        code: 'github-model-routing-access-ready',
        kind: 'ready',
        message: `Agent System LLM permissions allow the classifier default ${model}.`,
        model,
      }
    : {
        code: 'github-model-routing-access-drift',
        kind: 'update',
        message: `Saved Agent System LLM permissions do not fully allow the classifier default ${model}.`,
        model,
      };
}

function appendModel(value: string[] | undefined, model: string): string[] {
  const current = value ?? [];
  return current.includes('*') || current.includes(model) ? current : [...current, model];
}

function applyPlan(config: OpenClawConfig, context: AgentSystemLifecycleContext): boolean {
  const plan = planGitHubModelRoutingAccess(config, context);
  if (plan.kind !== 'update' || !plan.model) return false;
  const entry = (((config.plugins ??= {}).entries ??= {})[pluginId] ??= {});
  const llm = (entry.llm ??= {});
  llm.allowAgentIdOverride = true;
  llm.allowModelOverride = true;
  llm.allowedModels = appendModel(llm.allowedModels, plan.model);
  llm.allowedCompletionModels = appendModel(llm.allowedCompletionModels, plan.model);
  return true;
}

function staleFinding(model: string, unavailable = false): Finding {
  return {
    code: unavailable
      ? 'github-model-routing-loaded-access-unverified'
      : 'github-model-routing-loaded-access-stale',
    message: unavailable
      ? `Saved Agent System LLM permissions allow ${model}, but this process's loaded permissions could not be inspected.`
      : `Saved Agent System LLM permissions allow ${model}, but this process has not loaded them.`,
    remediation,
    status: 'warning',
  };
}

/** Doctor reads both saved and loaded state; only explicit install changes saved permissions. */
export default class GitHubModelRoutingAccess {
  constructor(readonly dependencies: GitHubModelRoutingAccessDependencies) {}

  async inspect(context: AgentSystemLifecycleContext): Promise<Finding[]> {
    let saved: ModelRoutingAccessPlan;
    try {
      saved = planGitHubModelRoutingAccess(await this.dependencies.readConfig(), context);
    } catch {
      return desiredModel(context)
        ? [
            {
              code: 'github-model-routing-saved-access-unverified',
              message: 'Saved Agent System LLM permissions could not be inspected.',
              remediation,
              status: 'warning',
            },
          ]
        : [];
    }
    if (saved.kind === 'inactive') return [];
    if (saved.kind === 'update') {
      return [{ code: saved.code, message: saved.message, remediation, status: 'drift' }];
    }
    try {
      const loaded = planGitHubModelRoutingAccess(
        await this.dependencies.readRuntimeConfig(),
        context,
      );
      return loaded.kind === 'ready'
        ? [{ code: loaded.code, message: loaded.message, status: 'healthy' }]
        : [staleFinding(saved.model!)];
    } catch {
      return [staleFinding(saved.model!, true)];
    }
  }

  async reconcile(context: AgentSystemLifecycleContext) {
    const initial = planGitHubModelRoutingAccess(await this.dependencies.readConfig(), context);
    if (initial.kind === 'inactive') return { outcomes: [], warnings: [] };
    let changed = false;
    if (initial.kind === 'update') {
      const mutation = await this.dependencies.mutateConfigFile({
        base: 'source',
        afterWrite: { mode: 'auto' },
        mutate: (config) => applyPlan(config, context),
      });
      changed = mutation.result === true;
    }
    const saved = planGitHubModelRoutingAccess(await this.dependencies.readConfig(), context);
    if (saved.kind !== 'ready') {
      throw new Error('Saved GitHub model-routing permissions did not converge after install.');
    }
    const findings = await this.inspect(context);
    const loadedWarning = findings.find(({ status }) => status === 'warning');
    return {
      outcomes: [
        {
          code: 'github-model-routing-access-reconciled',
          message: `Verified saved Agent System LLM permissions for classifier default ${saved.model}.`,
          status: changed ? ('updated' as const) : ('unchanged' as const),
        },
      ],
      warnings: loadedWarning
        ? [{ code: loadedWarning.code, message: `${loadedWarning.message} ${remediation}` }]
        : [],
    };
  }
}
