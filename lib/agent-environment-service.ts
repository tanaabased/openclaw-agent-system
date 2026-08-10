import { createHash } from 'node:crypto';

import collectOpEnvironmentRequirements, {
  hasOpEnvironmentRequirements,
} from '../utils/collect-op-environment-requirements.ts';
import loadAgentDotenv from '../utils/load-agent-dotenv.ts';
import resolveAgentEnvironment, {
  type AgentEnvironmentInputSource,
  type ResolvedAgentEnvironment,
} from '../utils/resolve-agent-environment.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type { AgentManifestLoadResult, ManifestLoadTrigger } from './agent-manifest-service.ts';
import type OpEnvironmentService from './op-environment-service.ts';

export type AgentEnvironmentLoadResult =
  | Exclude<AgentManifestLoadResult, { status: 'loaded' }>
  | (Extract<AgentManifestLoadResult, { status: 'loaded' }> & {
      environment: ResolvedAgentEnvironment;
    });

export interface AgentEnvironmentServiceDependencies {
  hostEnvironment: Readonly<Record<string, string | undefined>>;
  logger: {
    error(message: string): void;
    info(message: string): void;
  };
  loadDotenv?: typeof loadAgentDotenv;
  manifestService: Pick<
    AgentManifestService,
    'loadForAgentId' | 'loadForCommandDirectory' | 'loadForWorkspace'
  >;
  opEnvironmentService?: Pick<OpEnvironmentService, 'load'>;
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
  readonly #hostEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #loadDotenv: typeof loadAgentDotenv;

  constructor(dependencies: AgentEnvironmentServiceDependencies) {
    this.#dependencies = dependencies;
    this.#hostEnvironment = Object.freeze({ ...dependencies.hostEnvironment });
    this.#loadDotenv = dependencies.loadDotenv ?? loadAgentDotenv;
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

  async loadForCommandDirectory(
    commandDirectory: string,
    trigger: ManifestLoadTrigger = 'cli',
  ): Promise<AgentEnvironmentLoadResult> {
    return this.#resolve(
      await this.#dependencies.manifestService.loadForCommandDirectory(commandDirectory, trigger),
      trigger,
    );
  }

  async #resolve(
    result: AgentManifestLoadResult,
    trigger: ManifestLoadTrigger,
  ): Promise<AgentEnvironmentLoadResult> {
    if (result.status !== 'loaded') return result;

    const dotenv = await this.#loadDotenv(
      result.scope.workspaceDir,
      result.manifest.environment?.dotenv ?? [],
    );
    if (dotenv.status === 'invalid') {
      const diagnostics = [...result.diagnostics, ...dotenv.diagnostics];
      this.#logInvalidEnvironment(result.manifest.agent.id, trigger, diagnostics);
      return {
        status: 'invalid',
        scope: result.scope,
        path: result.path,
        diagnostics,
      };
    }

    const opRequirements = collectOpEnvironmentRequirements(result.manifest);
    let opSet: { sensitiveNames: string[]; values: Record<string, string> } | undefined;
    let opSources: AgentEnvironmentInputSource[] = [];
    if (hasOpEnvironmentRequirements(opRequirements)) {
      const opEnvironmentService = this.#dependencies.opEnvironmentService;
      if (!opEnvironmentService) {
        const diagnostics = [
          ...result.diagnostics,
          {
            code: 'op-integration-unavailable',
            fieldPath: '/environment',
            message: 'OP resource resolution is unavailable in this runtime.',
            severity: 'error' as const,
          },
        ];
        this.#logInvalidEnvironment(result.manifest.agent.id, trigger, diagnostics);
        return {
          status: 'invalid',
          scope: result.scope,
          path: result.path,
          diagnostics,
        };
      }
      const op = await opEnvironmentService.load(result.manifest.agent.id, opRequirements);
      if (op.status === 'invalid') {
        const diagnostics = [...result.diagnostics, ...op.diagnostics];
        this.#logInvalidEnvironment(result.manifest.agent.id, trigger, diagnostics);
        return {
          status: 'invalid',
          scope: result.scope,
          path: result.path,
          diagnostics,
        };
      }
      opSet = op.set;
      opSources = op.sources;
    }

    const resolution = resolveAgentEnvironment(result.manifest, this.#hostEnvironment, {
      dotenv: dotenv.sources,
      op: opSources,
      ...(opSet ? { set: opSet } : {}),
    });
    if (resolution.status === 'invalid') {
      const diagnostics = [...result.diagnostics, ...resolution.diagnostics];
      this.#logInvalidEnvironment(result.manifest.agent.id, trigger, diagnostics);
      return {
        status: 'invalid',
        scope: result.scope,
        path: result.path,
        diagnostics,
      };
    }

    const { environment } = resolution;
    this.#dependencies.logger.info(
      `environment_resolved trigger=${quote(trigger)} agentId=${quote(result.manifest.agent.id)} variables=${environment.variables.length} digest=${quote(environmentDigest(environment))}`,
    );
    return { ...result, environment };
  }

  #logInvalidEnvironment(
    agentId: string,
    trigger: ManifestLoadTrigger,
    diagnostics: AgentManifestLoadResult['diagnostics'],
  ): void {
    this.#dependencies.logger.error(
      `environment_invalid trigger=${quote(trigger)} agentId=${quote(agentId)} codes=${quote(diagnostics.map(({ code }) => code).join(','))}`,
    );
  }
}
