import type { AgentManifest } from '../utils/manifest-types.ts';
import type AgentSystemLifecycleRegistry from './lifecycle-registry.ts';
import type { AgentSystemLifecycleFinding } from './lifecycle-registry.ts';

export type AgentDoctorFinding = AgentSystemLifecycleFinding;

export interface AgentDoctorResult {
  agentId: string;
  findings: AgentDoctorFinding[];
  status: 'blocked' | 'healthy' | 'drift';
  workspaceDir: string;
}

export interface AgentDoctorServiceDependencies {
  lifecycleRegistry: Pick<AgentSystemLifecycleRegistry, 'inspect'>;
}

/** Aggregate read-only findings from every configured lifecycle component. */
export default class AgentDoctorService {
  readonly #dependencies: AgentDoctorServiceDependencies;

  constructor(dependencies: AgentDoctorServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(input: {
    manifest: AgentManifest;
    workspaceDir: string;
  }): Promise<AgentDoctorResult> {
    const findings = await this.#dependencies.lifecycleRegistry.inspect(input);
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
