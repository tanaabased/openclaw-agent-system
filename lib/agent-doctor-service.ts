import type { AgentManifest } from '../utils/manifest-types.ts';
import type AgentPathService from './agent-path-service.ts';
import type GitHubConfigStore from '../tools/github/config-store.ts';
import { resolveGitHubCliConfiguration } from '../tools/github/config-schema.ts';

export interface AgentDoctorFinding {
  code: string;
  message: string;
  remediation?: string;
  status: 'healthy' | 'manual' | 'warning' | 'drift';
}

export interface AgentDoctorResult {
  agentId: string;
  findings: AgentDoctorFinding[];
  status: 'healthy' | 'drift';
  workspaceDir: string;
}

export interface AgentDoctorServiceDependencies {
  githubConfigStore?: Pick<GitHubConfigStore, 'inspect'>;
  pathService: Pick<AgentPathService, 'inspect'>;
}

/** Report implemented Agent System drift without repairing workspace or OpenClaw state. */
export default class AgentDoctorService {
  readonly #dependencies: AgentDoctorServiceDependencies;

  constructor(dependencies: AgentDoctorServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(input: {
    manifest: AgentManifest;
    workspaceDir: string;
  }): Promise<AgentDoctorResult> {
    const findings: AgentDoctorFinding[] = [];
    try {
      const path = await this.#dependencies.pathService.inspect(input);
      findings.push(
        path.openClawMatches
          ? {
              code: 'openclaw-exec-path-ready',
              message: 'OpenClaw exec path matches the Agent System projection.',
              status: 'healthy',
            }
          : {
              code: 'openclaw-exec-path-drift',
              message: 'OpenClaw exec path does not match the Agent System projection.',
              remediation: 'Run openclaw agent-system install from this workspace.',
              status: 'drift',
            },
      );

      if (path.codex.ownership === 'managed') {
        findings.push(
          path.codex.pathMatches
            ? {
                code: 'codex-path-ready',
                message: 'Managed Codex workspace path matches the Agent System projection.',
                status: 'healthy',
              }
            : {
                code: 'codex-path-drift',
                message: 'Managed Codex workspace path does not match the Agent System projection.',
                remediation: 'Run openclaw agent-system install from this workspace.',
                status: 'drift',
              },
        );
      } else if (path.codex.ownership === 'absent') {
        findings.push({
          code: 'codex-config-missing',
          message: 'The Codex workspace path configuration is missing.',
          remediation: 'Run openclaw agent-system install from this workspace.',
          status: 'drift',
        });
      } else {
        findings.push({
          code:
            path.codex.ownership === 'manual' ? 'codex-config-manual' : 'codex-config-user-managed',
          message:
            'Codex workspace configuration is user-managed; Agent System will not repair it.',
          status: 'manual',
        });
      }

      findings.push(
        path.codex.gitignored
          ? {
              code: 'codex-config-gitignored',
              message: 'The local Codex workspace configuration is listed in .gitignore.',
              status: 'healthy',
            }
          : {
              code: 'codex-config-not-gitignored',
              message: 'The local Codex workspace configuration is not listed in .gitignore.',
              ...(path.codex.ownership === 'managed'
                ? { remediation: 'Run openclaw agent-system install from this workspace.' }
                : {}),
              status: path.codex.ownership === 'managed' ? 'drift' : 'warning',
            },
      );
    } catch (error) {
      findings.push({
        code: 'path-projection-invalid',
        message: error instanceof Error ? error.message : 'Executable path projection failed.',
        remediation: 'Correct the workspace paths, then run openclaw agent-system install.',
        status: 'drift',
      });
    }

    if (input.manifest.github && !this.#dependencies.githubConfigStore) {
      findings.push({
        code: 'github-config-unavailable',
        message: 'Generated GitHub CLI config inspection is unavailable.',
        remediation: 'Reload the Agent System plugin, then run openclaw agent-system doctor.',
        status: 'drift',
      });
    } else if (input.manifest.github && this.#dependencies.githubConfigStore) {
      try {
        const github = await this.#dependencies.githubConfigStore.inspect(
          input.manifest.agent.id,
          resolveGitHubCliConfiguration(input.manifest.github),
        );
        findings.push(
          github.status === 'ready'
            ? {
                code: 'github-config-ready',
                message: 'Generated GitHub CLI config matches the agent manifest.',
                status: 'healthy',
              }
            : {
                code: 'github-config-drift',
                message: 'Generated GitHub CLI config does not match the agent manifest.',
                remediation: 'Run openclaw agent-system install from this workspace.',
                status: 'drift',
              },
        );
      } catch (error) {
        findings.push({
          code: 'github-config-unsafe',
          message:
            error instanceof Error
              ? error.message
              : 'Generated GitHub CLI config could not be inspected.',
          remediation: 'Correct the private config path, then run openclaw agent-system install.',
          status: 'drift',
        });
      }
    }

    return {
      agentId: input.manifest.agent.id,
      findings,
      status: findings.some(({ status }) => status === 'drift') ? 'drift' : 'healthy',
      workspaceDir: input.workspaceDir,
    };
  }
}
