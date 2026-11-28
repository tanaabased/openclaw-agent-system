import { formatProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import { createHash } from 'node:crypto';

import collectOpEnvironmentRequirements, {
  hasOpEnvironmentRequirements,
} from './op-requirements.ts';
import loadAgentDotenv from './load-dotenv.ts';
import resolveAgentEnvironment, {
  type AgentEnvironmentInputSource,
  type AgentEnvironmentResolution,
  type ResolvedAgentEnvironment,
} from './resolve.ts';
import type AgentManifestService from '../manifest/service.ts';
import type { AgentManifestLoadResult, ManifestLoadTrigger } from '../manifest/service.ts';
import type OpEnvironmentService from './op-service.ts';
import type { AgentManifest } from '../manifest/types.ts';

export type AgentEnvironmentLoadResult =
  | Exclude<AgentManifestLoadResult, { status: 'loaded' }>
  | (Extract<AgentManifestLoadResult, { status: 'loaded' }> & {
      environment: ResolvedAgentEnvironment;
    });

interface WorkspaceEnvironmentDependencies {
  hostEnvironment: Readonly<Record<string, string | undefined>>;
  loadDotenv?: typeof loadAgentDotenv;
  opEnvironmentService?: Pick<OpEnvironmentService, 'load'> &
    Partial<Pick<OpEnvironmentService, 'flush'>>;
}

export interface AgentEnvironmentServiceDependencies extends WorkspaceEnvironmentDependencies {
  logger: {
    error(message: string): void;
    info(message: string): void;
  };
  manifestService: Pick<
    AgentManifestService,
    'loadForAgentId' | 'loadForCommandDirectory' | 'loadForWorkspace'
  >;
}

/** Resolve an already selected workspace manifest using the runtime's credential owner. */
export async function resolveWorkspaceEnvironment(
  manifest: AgentManifest,
  workspaceDir: string,
  dependencies: WorkspaceEnvironmentDependencies,
  options: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<AgentEnvironmentResolution> {
  const dotenv = await (dependencies.loadDotenv ?? loadAgentDotenv)(
    workspaceDir,
    manifest.environment?.dotenv ?? [],
  );
  if (dotenv.status === 'invalid') return dotenv;

  const opRequirements = collectOpEnvironmentRequirements(manifest);
  const opEnvironmentService = dependencies.opEnvironmentService;
  let opSet: { sensitiveNames: string[]; values: Record<string, string> } | undefined;
  let opSources: AgentEnvironmentInputSource[] = [];
  if (hasOpEnvironmentRequirements(opRequirements)) {
    if (!opEnvironmentService) {
      return {
        status: 'invalid',
        diagnostics: [
          {
            code: 'op-integration-unavailable',
            fieldPath: '/environment',
            message: 'OP resource resolution is unavailable in this runtime.',
            severity: 'error',
          },
        ],
      };
    }
    const op = await opEnvironmentService.load(manifest.agent.id, opRequirements, {
      workspaceDir,
      ...options,
    });
    if (op.status === 'invalid') return op;
    opSet = op.set;
    opSources = op.sources;
  } else {
    opEnvironmentService?.flush?.(manifest.agent.id);
  }

  const resolution = resolveAgentEnvironment(manifest, dependencies.hostEnvironment, {
    dotenv: dotenv.sources,
    op: opSources,
    ...(opSet ? { set: opSet } : {}),
  });
  if (resolution.status === 'invalid') opEnvironmentService?.flush?.(manifest.agent.id);
  return resolution;
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

  constructor(dependencies: AgentEnvironmentServiceDependencies) {
    this.#dependencies = dependencies;
    this.#hostEnvironment = Object.freeze({ ...dependencies.hostEnvironment });
  }

  invalidateCredentials(agentId: string): void {
    this.#dependencies.opEnvironmentService?.flush?.(agentId);
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

  /** Use the normal source precedence against the manifest admitted for this invocation. */
  async loadSelected(
    loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }>,
    names: readonly string[],
  ): Promise<Record<string, string>> {
    if (!names.length) return {};
    const result = await this.#resolve(loaded, 'cli');
    if (result.status !== 'loaded') throw new Error('The agent environment is unavailable.');
    return Object.fromEntries(
      names
        .filter((name) => Object.hasOwn(result.environment.values, name))
        .map((name) => [name, result.environment.values[name]!]),
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

    const resolution = await resolveWorkspaceEnvironment(
      result.manifest,
      result.scope.workspaceDir,
      {
        ...this.#dependencies,
        hostEnvironment: this.#hostEnvironment,
      },
    );
    if (resolution.status === 'invalid') {
      const diagnostics = [...result.diagnostics, ...resolution.diagnostics];
      this.#logInvalidEnvironment(result.manifest.agent.id, trigger, diagnostics);
      return { status: 'invalid', scope: result.scope, path: result.path, diagnostics };
    }

    const { environment } = resolution;
    Object.freeze(environment.values);
    Object.freeze(environment.sensitiveNames);
    for (const variable of environment.variables) {
      Object.freeze(variable.overriddenSources);
      Object.freeze(variable);
    }
    Object.freeze(environment.variables);
    Object.freeze(environment);
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
      `environment_invalid trigger=${quote(trigger)} agentId=${quote(agentId)} codes=${quote(diagnostics.map(({ code }) => code).join(','))}${diagnostics
        .filter((entry) => entry.providerDiagnostic)
        .slice(0, 8)
        .map((entry) => ` ${formatProviderDiagnostic(entry.providerDiagnostic!)}`)
        .join('')}`,
    );
  }
}
