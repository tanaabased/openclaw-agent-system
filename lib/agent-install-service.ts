import { listAgentEntries, resolveAgentWorkspaceDir } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import type { AgentManifest } from '../utils/manifest-types.ts';
import planAgentInstall, {
  type AgentInstallAction,
  type CurrentAgentInstallState,
  type DesiredAgentInstallState,
} from '../utils/plan-agent-install.ts';

export interface AgentInstallCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface AgentInstallResult {
  actions: AgentInstallAction[];
  agentId: string;
  workspaceDir: string;
}

export interface AgentInstallServiceDependencies {
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  runOpenClawCommand(args: string[], cwd: string): Promise<AgentInstallCommandResult>;
}

export interface AgentInstallInput {
  manifest: AgentManifest;
  workspaceDir: string;
}

export class AgentInstallError extends Error {
  override name = 'AgentInstallError';
}

function currentAgentState(config: OpenClawConfig, agentId: string): CurrentAgentInstallState {
  const normalizedAgentId = agentId.toLowerCase();
  const entries = listAgentEntries(config);
  const entry = entries.find(({ id }) => id.trim().toLowerCase() === normalizedAgentId);
  const exists = entry !== undefined || (entries.length === 0 && normalizedAgentId === 'main');
  if (!exists) return { exists: false };

  return {
    exists: true,
    workspaceDir: resolveAgentWorkspaceDir(config, normalizedAgentId),
    ...(entry?.identity === undefined ? {} : { identity: entry.identity }),
  };
}

function commandFailure(args: string[], result: AgentInstallCommandResult): AgentInstallError {
  const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new AgentInstallError(`OpenClaw ${args.join(' ')} failed: ${details}`);
}

/** Reconcile manifest-owned registration and identity through OpenClaw's public CLI. */
export default class AgentInstallService {
  readonly #dependencies: AgentInstallServiceDependencies;

  constructor(dependencies: AgentInstallServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async install(input: AgentInstallInput): Promise<AgentInstallResult> {
    const name = input.manifest.agent.name?.trim();
    if (!name) {
      throw new AgentInstallError('Agent System install requires agent.name in the manifest.');
    }

    const desired: DesiredAgentInstallState = {
      agentId: input.manifest.agent.id,
      workspaceDir: input.workspaceDir,
      identity: {
        name,
        ...(input.manifest.agent.avatar === undefined
          ? {}
          : { avatar: input.manifest.agent.avatar }),
      },
    };
    const initialConfig = await this.#dependencies.readConfig();
    const plan = planAgentInstall(desired, currentAgentState(initialConfig, desired.agentId));
    if (plan.status === 'conflict') {
      const configured = plan.configuredWorkspaceDir ?? 'an unresolved workspace';
      throw new AgentInstallError(
        `OpenClaw agent ${plan.agentId} already uses ${configured}; refusing to replace it with ${plan.desiredWorkspaceDir}.`,
      );
    }

    for (const action of plan.actions) {
      const args =
        action === 'add-agent'
          ? [
              'agents',
              'add',
              desired.agentId,
              '--workspace',
              plan.workspaceDir,
              '--non-interactive',
              '--json',
            ]
          : [
              'agents',
              'set-identity',
              '--agent',
              desired.agentId,
              '--workspace',
              plan.workspaceDir,
              '--name',
              desired.identity.name,
              ...(desired.identity.avatar === undefined
                ? []
                : ['--avatar', desired.identity.avatar]),
              '--json',
            ];
      const result = await this.#dependencies.runOpenClawCommand(args, plan.workspaceDir);
      if (result.code !== 0) throw commandFailure(args, result);
    }

    const verifiedConfig = await this.#dependencies.readConfig();
    const verification = planAgentInstall(
      desired,
      currentAgentState(verifiedConfig, desired.agentId),
    );
    if (verification.status !== 'ready' || verification.actions.length > 0) {
      throw new AgentInstallError(
        `OpenClaw agent ${desired.agentId} did not match its manifest after installation.`,
      );
    }

    return {
      actions: plan.actions,
      agentId: desired.agentId,
      workspaceDir: plan.workspaceDir,
    };
  }
}
