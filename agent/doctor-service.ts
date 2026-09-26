import type AgentSystemLifecycleRegistry from '../core/lifecycle-registry.ts';
import type AgentSystemToolRegistry from '../api/registry.ts';
import type { resolveToolExecutable } from '../api/cli-runner.ts';
import {
  excludedToolExecutableDirectories,
  executableGuidance,
  unavailableToolExecutables,
} from '../api/executable-requirements.ts';
import type {
  AgentSystemLifecycleExecutionContext,
  AgentSystemLifecycleFinding,
} from '../core/lifecycle-registry.ts';

export type AgentDoctorFinding = AgentSystemLifecycleFinding;

export interface AgentDoctorResult {
  agentId: string;
  findings: AgentDoctorFinding[];
  status: 'blocked' | 'healthy' | 'drift';
  workspaceDir: string;
}

export interface AgentDoctorServiceDependencies {
  lifecycleRegistry: Pick<AgentSystemLifecycleRegistry, 'inspect'>;
  toolRegistry?: Pick<AgentSystemToolRegistry, 'configuredExecutableRequirements'>;
  baseEnvironment?: Readonly<NodeJS.ProcessEnv>;
  excludedExecutableDirectories?: readonly string[];
  resolveExecutable?: typeof resolveToolExecutable;
}

/** Aggregate read-only findings from every configured lifecycle component. */
export default class AgentDoctorService {
  readonly #dependencies: AgentDoctorServiceDependencies;

  constructor(dependencies: AgentDoctorServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(input: AgentSystemLifecycleExecutionContext): Promise<AgentDoctorResult> {
    const findings = await this.#dependencies.lifecycleRegistry.inspect(input);
    if (input.runtime === 'openclaw' && this.#dependencies.toolRegistry) {
      const exclusions = excludedToolExecutableDirectories(
        input.manifest,
        input.workspaceDir,
        this.#dependencies.excludedExecutableDirectories,
      );
      for (const requirement of this.#dependencies.toolRegistry.configuredExecutableRequirements(
        input.manifest,
      )) {
        input.signal?.throwIfAborted();
        const unavailable = await unavailableToolExecutables(
          requirement.executables,
          this.#dependencies.baseEnvironment?.PATH ?? '',
          exclusions,
          this.#dependencies.resolveExecutable,
        );
        if (unavailable.length > 0) {
          findings.push({
            code: 'tool-executables-unavailable',
            component: requirement.id,
            message: executableGuidance(requirement.id, unavailable),
            remediation: `Install ${unavailable.join(', ')} on the host and make them available on the runtime PATH.`,
            status: 'blocked',
          });
        }
      }
    }
    return {
      agentId: input.manifest.agent.id,
      findings,
      status: findings.some(({ status }) => status === 'blocked')
        ? 'blocked'
        : findings.some(({ status }) => status === 'drift')
          ? 'drift'
          : 'healthy',
      workspaceDir: input.workspaceDir,
    };
  }
}
