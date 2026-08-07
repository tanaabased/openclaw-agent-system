import { listAgentEntries, resolveAgentWorkspaceDir } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import type { AgentManifest } from '../utils/manifest-types.ts';
import planAgentInstall, {
  type AgentInstallAction,
  type CurrentAgentInstallState,
  type DesiredAgentInstallState,
} from '../utils/plan-agent-install.ts';
import resolveManifestValue from '../utils/resolve-manifest-value.ts';
import type AgentEnvironmentService from './agent-environment-service.ts';
import type OpCredentialManager from './op-credential-manager.ts';
import type AgentPathService from './agent-path-service.ts';
import type { AgentPathInstallAction, AgentPathWarning } from './agent-path-service.ts';

export interface AgentInstallCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface AgentInstallResult {
  actions: Array<AgentInstallAction | AgentPathInstallAction>;
  agentId: string;
  codexStatus?: 'managed' | 'manual';
  warnings: AgentPathWarning[];
  workspaceDir: string;
}

export interface AgentInstallServiceDependencies {
  credentialManager?: Pick<OpCredentialManager, 'validateStoredForInstall'>;
  environmentService?: Pick<AgentEnvironmentService, 'loadForWorkspace'>;
  pathService?: Pick<AgentPathService, 'inspect' | 'reconcile'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  runOpenClawCommand(args: string[], cwd: string): Promise<AgentInstallCommandResult>;
}

export interface AgentInstallInput {
  manifest: AgentManifest;
  workspaceDir: string;
}

export class AgentInstallError extends Error {
  override name = 'AgentInstallError';

  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
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

function environmentFailure(
  result: Awaited<ReturnType<AgentEnvironmentService['loadForWorkspace']>>,
): AgentInstallError {
  const diagnostic = result.diagnostics.find(({ severity }) => severity === 'error');
  return new AgentInstallError(
    diagnostic?.message ?? 'Agent System could not resolve the manifest environment.',
    diagnostic?.code ?? 'agent-environment-unavailable',
  );
}

/** Reconcile manifest-owned registration, identity, and executable paths. */
export default class AgentInstallService {
  readonly #dependencies: AgentInstallServiceDependencies;

  constructor(dependencies: AgentInstallServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async install(input: AgentInstallInput): Promise<AgentInstallResult> {
    const configuredName = input.manifest.agent.name;
    if (configuredName === undefined) {
      throw new AgentInstallError('Agent System install requires agent.name in the manifest.');
    }
    if (typeof configuredName === 'string' && !configuredName.trim()) {
      throw new AgentInstallError('Agent System install requires agent.name in the manifest.');
    }

    if ((input.manifest.environment?.op?.length ?? 0) > 0) {
      const credentialManager = this.#dependencies.credentialManager;
      if (!credentialManager) {
        throw new AgentInstallError(
          'Stored OP credential validation is unavailable.',
          'op-credential-unavailable',
        );
      }
      const readiness = await credentialManager.validateStoredForInstall(input.manifest);
      if (readiness.status === 'invalid') {
        throw new AgentInstallError(readiness.message, readiness.code);
      }
    }

    let environment: Readonly<Record<string, string | undefined>> = {};
    if (typeof configuredName !== 'string') {
      const environmentService = this.#dependencies.environmentService;
      if (!environmentService) {
        throw new AgentInstallError(
          'Agent System environment resolution is unavailable during install.',
          'agent-environment-unavailable',
        );
      }
      const result = await environmentService.loadForWorkspace(
        input.workspaceDir,
        input.manifest.agent.id,
        'cli',
      );
      if (result.status !== 'loaded') throw environmentFailure(result);
      environment = result.environment.values;
    }
    const nameResolution = resolveManifestValue(configuredName, environment, '/agent/name');
    if (nameResolution.status === 'invalid') {
      throw new AgentInstallError(
        nameResolution.diagnostic.message,
        nameResolution.diagnostic.code,
      );
    }

    const name = nameResolution.value.trim();
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

    const pathResult = await this.#dependencies.pathService?.reconcile(input);

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
    if (pathResult) {
      const pathInspection = await this.#dependencies.pathService?.inspect(input);
      if (!pathInspection?.openClawMatches) {
        throw new AgentInstallError(
          `OpenClaw agent ${desired.agentId} did not retain its Agent System executable path after installation.`,
        );
      }
      if (
        pathResult.codexStatus === 'managed' &&
        (!pathInspection.codex.pathMatches || !pathInspection.codex.gitignored)
      ) {
        throw new AgentInstallError(
          `Codex path configuration for ${desired.agentId} did not match after installation.`,
        );
      }
    }

    return {
      actions: [...plan.actions, ...(pathResult?.actions ?? [])],
      agentId: desired.agentId,
      ...(pathResult ? { codexStatus: pathResult.codexStatus } : {}),
      warnings: pathResult?.warnings ?? [],
      workspaceDir: plan.workspaceDir,
    };
  }
}
