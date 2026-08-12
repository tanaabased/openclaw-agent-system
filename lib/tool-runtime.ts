import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { Static, TSchema } from 'typebox';

import resolveManifestValue from '../utils/resolve-manifest-value.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import type AgentEnvironmentService from './agent-environment-service.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import AgentSystemToolError from './tool-error.ts';
import executeAgentSystemCliTool from './tool-cli-execution.ts';
import loadBoundToolManifest from './tool-manifest-binding.ts';
import runToolCli from './tool-cli-runner.ts';
import type {
  AgentSystemAuditEvent,
  AgentSystemAuthorizationDecision,
  AgentSystemAuthorizationRequest,
  AgentSystemCliToolExecutionResult,
  AgentSystemCliToolDefinition,
  AgentSystemOperation,
  AgentSystemSemanticToolExecutionResult,
  AgentSystemSemanticToolExecutionPayload,
  AgentSystemSemanticToolDefinition,
  AgentSystemToolExecutionMetadata,
  AgentSystemToolExecutionPayload,
  AgentSystemToolScope,
} from './tool-types.ts';

interface ToolLogger {
  error(message: string): void;
  info(message: string): void;
}

export interface AgentSystemToolRuntimeDependencies {
  audit?: { record(event: AgentSystemAuditEvent): Promise<void> | void };
  authorize?(request: AgentSystemAuthorizationRequest): Promise<AgentSystemAuthorizationDecision>;
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId'>;
  excludedExecutableDirectories?: readonly string[];
  logger: ToolLogger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  runCli?: typeof runToolCli;
}

interface RuntimeDefinition<
  TParameters extends TSchema,
  TDeclaredConfiguration,
  TResolvedConfiguration,
> {
  authorization?: AgentSystemCliToolDefinition<
    TParameters,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    unknown
  >['authorization'];
  configuration: AgentSystemCliToolDefinition<
    TParameters,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    unknown
  >['configuration'];
  id: string;
  tool: {
    classify(
      input: Static<TParameters>,
      configuration: TDeclaredConfiguration,
    ): AgentSystemOperation;
    name: string;
    validate?(input: Static<TParameters>, configuration: TDeclaredConfiguration): void;
  };
}

interface RuntimeExecutionContext<TResolvedConfiguration> {
  agentId: string;
  manifest: AgentManifest;
  resolvedConfiguration: TResolvedConfiguration;
  values: Readonly<Record<string, string>>;
  workspaceDir: string;
}

function quote(value: string | number): string {
  return JSON.stringify(value);
}

function hashToolInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function defaultAuthorize(
  request: AgentSystemAuthorizationRequest,
): Promise<AgentSystemAuthorizationDecision> {
  return Promise.resolve(
    request.operation.risk === 'read'
      ? { status: 'allowed' }
      : {
          status: 'denied',
          reason: `Agent System does not yet authorize ${request.operation.risk} tool operations.`,
        },
  );
}

/** Execute tools through one agent-binding, authorization, credential, and audit path. */
export default class AgentSystemToolRuntime {
  readonly #dependencies: AgentSystemToolRuntimeDependencies;
  readonly #runCli: typeof runToolCli;

  constructor(dependencies: AgentSystemToolRuntimeDependencies) {
    this.#dependencies = dependencies;
    this.#runCli = dependencies.runCli ?? runToolCli;
  }

  executeCli<TParameters extends TSchema, TDeclaredConfiguration, TResolvedConfiguration, TOutput>(
    definition: AgentSystemCliToolDefinition<
      TParameters,
      TDeclaredConfiguration,
      TResolvedConfiguration,
      TOutput
    >,
    input: Static<TParameters>,
    scope: AgentSystemToolScope,
    signal?: AbortSignal,
  ): Promise<AgentSystemCliToolExecutionResult<TOutput>> {
    return this.#execute(definition, input, scope, (context) =>
      executeAgentSystemCliTool({
        baseEnvironment: this.#dependencies.baseEnvironment,
        context,
        definition,
        excludedExecutableDirectories: this.#dependencies.excludedExecutableDirectories,
        input,
        runCli: this.#runCli,
        scope,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  }

  executeSemantic<
    TParameters extends TSchema,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    TOutput,
  >(
    definition: AgentSystemSemanticToolDefinition<
      TParameters,
      TDeclaredConfiguration,
      TResolvedConfiguration,
      TOutput
    >,
    input: Static<TParameters>,
    scope: AgentSystemToolScope,
    signal?: AbortSignal,
  ): Promise<AgentSystemSemanticToolExecutionResult<TOutput>> {
    return this.#execute(definition, input, scope, async (context) => {
      const output = await definition.execute(input, context.resolvedConfiguration, {
        agentId: context.agentId,
        resolveEnvironment(name) {
          return context.values[name];
        },
        ...(signal === undefined ? {} : { signal }),
        source: scope.source,
        ...(scope.toolContext === undefined ? {} : { toolContext: scope.toolContext }),
        workspaceDir: context.workspaceDir,
      });
      return { kind: 'semantic', output } as AgentSystemSemanticToolExecutionPayload<TOutput>;
    });
  }

  async #execute<
    TParameters extends TSchema,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    TPayload extends AgentSystemToolExecutionPayload,
  >(
    definition: RuntimeDefinition<TParameters, TDeclaredConfiguration, TResolvedConfiguration>,
    input: Static<TParameters>,
    scope: AgentSystemToolScope,
    perform: (context: RuntimeExecutionContext<TResolvedConfiguration>) => Promise<TPayload>,
  ): Promise<AgentSystemToolExecutionMetadata & TPayload> {
    const loaded = await loadBoundToolManifest(this.#dependencies.manifestService, scope);
    const agentId = loaded.manifest.agent.id;
    const workspaceDir = loaded.scope.workspaceDir;
    const declaredConfiguration = definition.configuration.read(loaded.manifest);
    if (declaredConfiguration === undefined) {
      throw new AgentSystemToolError(
        'capability_not_configured',
        `Agent ${agentId} does not configure the ${definition.id} tool.`,
      );
    }
    try {
      definition.tool.validate?.(input, declaredConfiguration);
    } catch {
      throw new AgentSystemToolError(
        'invalid_arguments',
        `The ${definition.tool.name} request is invalid.`,
      );
    }
    const operation = definition.tool.classify(input, declaredConfiguration);
    const request = {
      agentId,
      operation,
      toolId: definition.id,
      toolName: definition.tool.name,
    };
    const authorization = definition.authorization?.authorize
      ? await definition.authorization.authorize(operation, declaredConfiguration)
      : await (this.#dependencies.authorize ?? defaultAuthorize)(request);
    if (authorization.status === 'denied') {
      throw new AgentSystemToolError(
        operation.risk === 'unknown' ? 'operation_unclassified' : 'approval_denied',
        authorization.reason,
      );
    }
    if (definition.authorization?.authorize && this.#dependencies.authorize) {
      const approval = await this.#dependencies.authorize(request);
      if (approval.status !== 'allowed') {
        throw new AgentSystemToolError('approval_denied', approval.reason);
      }
    }

    const auditId = randomUUID();
    const startedAt = Date.now();
    const baseAudit = {
      action: operation.action,
      agentId,
      auditId,
      inputHash: hashToolInput(input),
      toolId: definition.id,
      risk: operation.risk,
      source: scope.source,
      toolName: definition.tool.name,
    } as const;
    await this.#recordAudit({ ...baseAudit, phase: 'pending' });
    this.#dependencies.logger.info(
      `tool_call_started auditId=${quote(auditId)} tool=${quote(definition.id)} openClawTool=${quote(definition.tool.name)} agentId=${quote(agentId)} action=${quote(operation.action)} risk=${quote(operation.risk)} source=${quote(scope.source)}`,
    );

    try {
      const environmentResult = await this.#dependencies.environmentService.loadForAgentId(
        agentId,
        'cli',
      );
      if (
        environmentResult.status !== 'loaded' ||
        resolve(environmentResult.scope.workspaceDir) !== resolve(workspaceDir)
      ) {
        throw new AgentSystemToolError(
          'credential_unavailable',
          `The ${definition.id} tool environment is unavailable for agent ${agentId}.`,
        );
      }
      const values = environmentResult.environment.values;
      const resolvedConfiguration = definition.configuration.resolve(declaredConfiguration, {
        resolve(value, fieldPath) {
          const result = resolveManifestValue(value, values, fieldPath);
          if (result.status === 'invalid') {
            throw new AgentSystemToolError('credential_unavailable', result.diagnostic.message);
          }
          return result.value;
        },
      });
      const result = await perform({
        agentId,
        manifest: loaded.manifest,
        resolvedConfiguration,
        values,
        workspaceDir,
      });
      const durationMs = Date.now() - startedAt;
      const exitCode = result.kind === 'cli' ? result.commandResult.exitCode : undefined;
      await this.#recordAudit({
        ...baseAudit,
        durationMs,
        phase: 'completed',
        status:
          result.kind === 'semantic'
            ? 'ok'
            : exitCode === 0
              ? 'ok'
              : `exit-${exitCode === null ? 'unknown' : exitCode}`,
        ...(result.kind === 'cli' ? { truncated: result.commandResult.truncated } : {}),
      });
      this.#dependencies.logger.info(
        `tool_call_completed auditId=${quote(auditId)} tool=${quote(definition.id)} openClawTool=${quote(definition.tool.name)} agentId=${quote(agentId)} action=${quote(operation.action)} source=${quote(scope.source)} durationMs=${durationMs} kind=${quote(result.kind)}${result.kind === 'cli' ? ` exitCode=${quote(exitCode ?? 'unknown')} truncated=${result.commandResult.truncated}` : ''}`,
      );
      return { auditId, operation, ...result };
    } catch (error) {
      const toolError =
        error instanceof AgentSystemToolError
          ? error
          : new AgentSystemToolError(
              'execution_failed',
              `The ${definition.id} tool request failed.`,
            );
      const durationMs = Date.now() - startedAt;
      await this.#recordAudit({
        ...baseAudit,
        durationMs,
        phase: 'failed',
        status: toolError.code,
      });
      this.#dependencies.logger.error(
        `tool_call_failed auditId=${quote(auditId)} tool=${quote(definition.id)} openClawTool=${quote(definition.tool.name)} agentId=${quote(agentId)} action=${quote(operation.action)} source=${quote(scope.source)} durationMs=${durationMs} code=${quote(toolError.code)}`,
      );
      throw toolError;
    }
  }

  async #recordAudit(event: AgentSystemAuditEvent): Promise<void> {
    await this.#dependencies.audit?.record(event);
  }
}
