import { listAgentEntries, resolveAgentWorkspaceDir } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import planAgentInstall, {
  type AgentInstallAction,
  type CurrentAgentInstallState,
  type DesiredAgentInstallState,
} from '../utils/plan-agent-install.ts';
import resolveManifestValue from '../utils/resolve-manifest-value.ts';
import type AgentEnvironmentService from './agent-environment-service.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleContext,
} from './lifecycle-registry.ts';

export interface AgentLifecycleCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface AgentLifecycleDependencies {
  environmentService?: Pick<AgentEnvironmentService, 'loadForWorkspace'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  runOpenClawCommand(args: string[], cwd: string): Promise<AgentLifecycleCommandResult>;
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

function lifecycleError(code: string, message: string, options?: ErrorOptions) {
  return new AgentSystemLifecycleError('agent', code, message, options);
}

function commandFailure(args: string[], result: AgentLifecycleCommandResult) {
  const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return lifecycleError(
    'openclaw-agent-command-failed',
    `OpenClaw ${args.join(' ')} failed: ${details}`,
  );
}

async function desiredAgentState(
  context: AgentSystemLifecycleContext,
  dependencies: AgentLifecycleDependencies,
): Promise<DesiredAgentInstallState> {
  const configuredName = context.manifest.agent.name;
  if (
    configuredName === undefined ||
    (typeof configuredName === 'string' && !configuredName.trim())
  ) {
    throw lifecycleError(
      'agent-name-required',
      'Agent System install requires agent.name in the manifest.',
    );
  }

  let environment: Readonly<Record<string, string | undefined>> = {};
  if (typeof configuredName !== 'string') {
    const environmentService = dependencies.environmentService;
    if (!environmentService) {
      throw lifecycleError(
        'agent-environment-unavailable',
        'Agent System environment resolution is unavailable for agent.name.',
      );
    }
    const result = await environmentService.loadForWorkspace(
      context.workspaceDir,
      context.manifest.agent.id,
      'cli',
    );
    if (result.status !== 'loaded') {
      const diagnostic = result.diagnostics.find(({ severity }) => severity === 'error');
      throw lifecycleError(
        diagnostic?.code ?? 'agent-environment-unavailable',
        diagnostic?.message ?? 'Agent System could not resolve agent.name from the environment.',
      );
    }
    environment = result.environment.values;
  }

  const nameResolution = resolveManifestValue(configuredName, environment, '/agent/name');
  if (nameResolution.status === 'invalid') {
    throw lifecycleError(nameResolution.diagnostic.code, nameResolution.diagnostic.message);
  }
  const name = nameResolution.value.trim();
  if (!name) {
    throw lifecycleError(
      'agent-name-required',
      'Agent System install requires agent.name in the manifest.',
    );
  }

  return {
    agentId: context.manifest.agent.id,
    workspaceDir: context.workspaceDir,
    identity: {
      name,
      ...(context.manifest.agent.avatar === undefined
        ? {}
        : { avatar: context.manifest.agent.avatar }),
    },
  };
}

function commandArguments(
  action: AgentInstallAction,
  desired: DesiredAgentInstallState,
  workspaceDir: string,
): string[] {
  if (action === 'add-agent') {
    return [
      'agents',
      'add',
      desired.agentId,
      '--workspace',
      workspaceDir,
      '--non-interactive',
      '--json',
    ];
  }
  return [
    'agents',
    'set-identity',
    '--agent',
    desired.agentId,
    '--workspace',
    workspaceDir,
    '--name',
    desired.identity.name,
    ...(desired.identity.avatar === undefined ? [] : ['--avatar', desired.identity.avatar]),
    '--json',
  ];
}

/** Own OpenClaw agent registration and public identity lifecycle state. */
export default function createAgentLifecycleContribution(
  dependencies: AgentLifecycleDependencies,
): AgentSystemLifecycleContribution {
  return {
    id: 'agent',
    isConfigured: () => true,
    validate: () => ({
      code: 'agent-declaration-valid',
      summary: 'OpenClaw agent declaration',
    }),
    async inspect(context) {
      let desired: DesiredAgentInstallState;
      try {
        desired = await desiredAgentState(context, dependencies);
      } catch (error) {
        if (!(error instanceof AgentSystemLifecycleError)) throw error;
        return [
          {
            code: error.code,
            message: error.message,
            remediation: 'Correct the agent declaration or environment, then run install.',
            status: 'blocked',
          },
        ];
      }

      const plan = planAgentInstall(
        desired,
        currentAgentState(await dependencies.readConfig(), desired.agentId),
      );
      if (plan.status === 'conflict') {
        return [
          {
            code: 'agent-workspace-conflict',
            message: `OpenClaw agent ${plan.agentId} is registered to ${plan.configuredWorkspaceDir ?? 'an unresolved workspace'} instead of ${plan.desiredWorkspaceDir}.`,
            remediation: 'Resolve the conflicting OpenClaw registration, then run install.',
            status: 'blocked',
          },
        ];
      }
      if (plan.actions.length === 0) {
        return [
          {
            code: 'agent-ready',
            message: `OpenClaw registration and identity for ${desired.agentId} match the manifest.`,
            status: 'healthy',
          },
        ];
      }
      return [
        plan.actions.includes('add-agent')
          ? {
              code: 'agent-registration-drift',
              message: `OpenClaw agent ${desired.agentId} is not registered to this workspace.`,
              remediation: 'Run openclaw agent-system install from this workspace.',
              status: 'drift',
            }
          : {
              code: 'agent-identity-drift',
              message: `OpenClaw identity for ${desired.agentId} does not match the manifest.`,
              remediation: 'Run openclaw agent-system install from this workspace.',
              status: 'drift',
            },
      ];
    },
    async reconcile(context) {
      const desired = await desiredAgentState(context, dependencies);
      const plan = planAgentInstall(
        desired,
        currentAgentState(await dependencies.readConfig(), desired.agentId),
      );
      if (plan.status === 'conflict') {
        throw lifecycleError(
          'agent-workspace-conflict',
          `OpenClaw agent ${plan.agentId} already uses ${plan.configuredWorkspaceDir ?? 'an unresolved workspace'}; refusing to replace it with ${plan.desiredWorkspaceDir}.`,
        );
      }

      for (const action of plan.actions) {
        const args = commandArguments(action, desired, plan.workspaceDir);
        const result = await dependencies.runOpenClawCommand(args, plan.workspaceDir);
        if (result.code !== 0) throw commandFailure(args, result);
      }

      const verification = planAgentInstall(
        desired,
        currentAgentState(await dependencies.readConfig(), desired.agentId),
      );
      if (verification.status !== 'ready' || verification.actions.length > 0) {
        throw lifecycleError(
          'agent-verification-failed',
          `OpenClaw agent ${desired.agentId} did not match its manifest after installation.`,
        );
      }

      return {
        outcomes:
          plan.actions.length === 0
            ? [
                {
                  code: 'agent-unchanged',
                  message: `OpenClaw registration and identity for ${desired.agentId}`,
                  status: 'unchanged' as const,
                },
              ]
            : plan.actions.map((action) =>
                action === 'add-agent'
                  ? {
                      code: action,
                      message: `OpenClaw agent ${desired.agentId}`,
                      status: 'created' as const,
                    }
                  : {
                      code: action,
                      message: `OpenClaw identity for ${desired.agentId}`,
                      status: 'updated' as const,
                    },
              ),
      };
    },
  };
}
