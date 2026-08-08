import type AgentPathService from './agent-path-service.ts';
import type { AgentPathInstallAction } from './agent-path-service.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleOutcome,
} from './lifecycle-registry.ts';

export interface PathLifecycleDependencies {
  pathService: Pick<AgentPathService, 'inspect' | 'reconcile'>;
}

type PathOutcome = Omit<AgentSystemLifecycleOutcome, 'component'>;

function pathOutcome(action: AgentPathInstallAction, agentId: string): PathOutcome {
  if (action === 'create-workspace-bin') {
    return {
      code: action,
      message: 'workspace bin directory',
      status: 'created',
    };
  }
  if (action === 'set-exec-path') {
    return {
      code: action,
      message: `OpenClaw exec path for ${agentId}`,
      status: 'updated',
    };
  }
  if (action === 'create-codex-config') {
    return {
      code: action,
      message: 'Codex workspace path configuration',
      status: 'created',
    };
  }
  return {
    code: action,
    message:
      action === 'update-codex-config'
        ? 'Codex workspace path configuration'
        : 'workspace .gitignore',
    status: 'updated',
  };
}

/** Own the OpenClaw and local Codex executable-path projections. */
export default function createPathLifecycleContribution(
  dependencies: PathLifecycleDependencies,
): AgentSystemLifecycleContribution {
  return {
    id: 'path',
    isConfigured: () => true,
    validate: () => ({ summary: 'Executable path projection' }),
    async inspect(context) {
      try {
        const path = await dependencies.pathService.inspect(context);
        return [
          path.openClawMatches
            ? {
                code: 'openclaw-exec-path-ready',
                message: 'OpenClaw exec path matches the Agent System projection.',
                status: 'healthy' as const,
              }
            : {
                code: 'openclaw-exec-path-drift',
                message: 'OpenClaw exec path does not match the Agent System projection.',
                remediation: 'Run openclaw agent-system install from this workspace.',
                status: 'drift' as const,
              },
          path.codex.ownership === 'managed'
            ? path.codex.pathMatches
              ? {
                  code: 'codex-path-ready',
                  message: 'Managed Codex workspace path matches the Agent System projection.',
                  status: 'healthy' as const,
                }
              : {
                  code: 'codex-path-drift',
                  message:
                    'Managed Codex workspace path does not match the Agent System projection.',
                  remediation: 'Run openclaw agent-system install from this workspace.',
                  status: 'drift' as const,
                }
            : path.codex.ownership === 'absent'
              ? {
                  code: 'codex-config-missing',
                  message: 'The Codex workspace path configuration is missing.',
                  remediation: 'Run openclaw agent-system install from this workspace.',
                  status: 'drift' as const,
                }
              : {
                  code:
                    path.codex.ownership === 'manual'
                      ? 'codex-config-manual'
                      : 'codex-config-user-managed',
                  message:
                    'Codex workspace configuration is user-managed; Agent System will not repair it.',
                  status: 'manual' as const,
                },
          path.codex.gitignored
            ? {
                code: 'codex-config-gitignored',
                message: 'The local Codex workspace configuration is listed in .gitignore.',
                status: 'healthy' as const,
              }
            : {
                code: 'codex-config-not-gitignored',
                message: 'The local Codex workspace configuration is not listed in .gitignore.',
                ...(path.codex.ownership === 'managed'
                  ? { remediation: 'Run openclaw agent-system install from this workspace.' }
                  : {}),
                status:
                  path.codex.ownership === 'managed' ? ('drift' as const) : ('warning' as const),
              },
        ];
      } catch (error) {
        return [
          {
            code: 'path-projection-invalid',
            message: error instanceof Error ? error.message : 'Executable path projection failed.',
            remediation: 'Correct the workspace paths, then run openclaw agent-system install.',
            status: 'drift',
          },
        ];
      }
    },
    async reconcile(context) {
      let result: Awaited<ReturnType<AgentPathService['reconcile']>>;
      try {
        result = await dependencies.pathService.reconcile(context);
        const verification = await dependencies.pathService.inspect(context);
        if (!verification.openClawMatches) {
          throw new AgentSystemLifecycleError(
            'path',
            'openclaw-exec-path-verification-failed',
            `OpenClaw agent ${context.manifest.agent.id} did not retain its Agent System executable path after installation.`,
          );
        }
        if (
          result.codexStatus === 'managed' &&
          (!verification.codex.pathMatches || !verification.codex.gitignored)
        ) {
          throw new AgentSystemLifecycleError(
            'path',
            'codex-path-verification-failed',
            `Codex path configuration for ${context.manifest.agent.id} did not match after installation.`,
          );
        }
      } catch (error) {
        if (error instanceof AgentSystemLifecycleError) throw error;
        throw new AgentSystemLifecycleError(
          'path',
          'path-reconcile-failed',
          error instanceof Error ? error.message : 'Executable path projection failed.',
          { cause: error },
        );
      }

      return {
        outcomes:
          result.actions.length === 0
            ? [
                {
                  code: 'path-unchanged',
                  message: `Executable path projection for ${context.manifest.agent.id}`,
                  status: 'unchanged' as const,
                },
              ]
            : result.actions.map((action) => pathOutcome(action, context.manifest.agent.id)),
        warnings: result.warnings,
      };
    },
  };
}
