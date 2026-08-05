import { createHash } from 'node:crypto';

import resolveAgentEnvironment, {
  type ResolvedAgentEnvironment,
} from '../utils/resolve-agent-environment.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type { AgentManifestLoadResult, ManifestLoadTrigger } from './agent-manifest-service.ts';

export type AgentEnvironmentLoadResult =
  | Exclude<AgentManifestLoadResult, { status: 'loaded' }>
  | (Extract<AgentManifestLoadResult, { status: 'loaded' }> & {
      environment: ResolvedAgentEnvironment;
    });

export interface AgentEnvironmentServiceDependencies {
  logger: {
    info(message: string): void;
  };
  manifestService: Pick<
    AgentManifestService,
    'loadForAgentId' | 'loadForRuntimeContext' | 'loadForWorkspace'
  >;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function environmentDigest(environment: ResolvedAgentEnvironment): string {
  return createHash('sha256')
    .update(JSON.stringify(environment.variables))
    .digest('hex')
    .slice(0, 12);
}

/** Resolve one manifest's environment while keeping values out of diagnostics. */
export default class AgentEnvironmentService {
  readonly #dependencies: AgentEnvironmentServiceDependencies;

  constructor(dependencies: AgentEnvironmentServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async loadForRuntimeContext(
    context: Parameters<AgentManifestService['loadForRuntimeContext']>[0],
    trigger: Exclude<ManifestLoadTrigger, 'cli'>,
  ): Promise<AgentEnvironmentLoadResult> {
    return this.#resolve(
      await this.#dependencies.manifestService.loadForRuntimeContext(context, trigger),
      trigger,
    );
  }

  async loadForAgentId(
    agentId: string,
    trigger: ManifestLoadTrigger = 'cli',
  ): Promise<AgentEnvironmentLoadResult> {
    return this.#resolve(
      await this.#dependencies.manifestService.loadForAgentId(agentId, trigger),
      trigger,
    );
  }

  async loadForWorkspace(
    workspaceDir: string,
    expectedAgentId?: string,
    trigger: ManifestLoadTrigger = 'cli',
  ): Promise<AgentEnvironmentLoadResult> {
    return this.#resolve(
      await this.#dependencies.manifestService.loadForWorkspace(
        workspaceDir,
        expectedAgentId,
        trigger,
      ),
      trigger,
    );
  }

  #resolve(
    result: AgentManifestLoadResult,
    trigger: ManifestLoadTrigger,
  ): AgentEnvironmentLoadResult {
    if (result.status !== 'loaded') return result;

    const environment = resolveAgentEnvironment(result.manifest);
    this.#dependencies.logger.info(
      `agent_system.environment_resolved trigger=${quote(trigger)} agentId=${quote(result.manifest.agent.id)} variables=${environment.variables.length} digest=${quote(environmentDigest(environment))}`,
    );
    return { ...result, environment };
  }
}
