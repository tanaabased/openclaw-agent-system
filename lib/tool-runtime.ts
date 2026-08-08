import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import type { Static, TSchema } from 'typebox';

import resolveManifestValue from '../utils/resolve-manifest-value.ts';
import type AgentEnvironmentService from './agent-environment-service.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import runToolCli from './tool-cli-runner.ts';
import type {
  AgentSystemAuditEvent,
  AgentSystemAuthorizationDecision,
  AgentSystemAuthorizationRequest,
  AgentSystemCliToolDefinition,
  AgentSystemCliResult,
  AgentSystemToolExecutionResult,
  AgentSystemToolScope,
} from './tool-types.ts';

export type AgentSystemToolErrorCode =
  | 'agent_not_resolved'
  | 'approval_denied'
  | 'capability_not_configured'
  | 'credential_unavailable'
  | 'execution_failed'
  | 'execution_timed_out'
  | 'invalid_arguments'
  | 'operation_unclassified'
  | 'tool_identity_mismatch'
  | 'tool_unavailable';

export class AgentSystemToolError extends Error {
  override name = 'AgentSystemToolError';

  constructor(
    readonly code: AgentSystemToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

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
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  runCli?: typeof runToolCli;
}

const baselineEnvironmentNames = [
  'HOME',
  'LANG',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'TMPDIR',
] as const;

function quote(value: string): string {
  return JSON.stringify(value);
}

function inputHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (output, secret) => (secret ? output.split(secret).join('[REDACTED]') : output),
    value,
  );
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

  async executeCli<
    TParameters extends TSchema,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    TOutput,
  >(
    definition: AgentSystemCliToolDefinition<
      TParameters,
      TDeclaredConfiguration,
      TResolvedConfiguration,
      TOutput
    >,
    input: Static<TParameters>,
    scope: AgentSystemToolScope,
    signal?: AbortSignal,
  ): Promise<AgentSystemToolExecutionResult> {
    const loaded = await this.#loadBoundManifest(scope);
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
    if (operation.risk === 'unknown') {
      throw new AgentSystemToolError(
        'operation_unclassified',
        `The ${definition.tool.name} request could not be classified safely.`,
      );
    }
    const authorization = await (this.#dependencies.authorize ?? defaultAuthorize)({
      agentId,
      operation,
      toolId: definition.id,
      toolName: definition.tool.name,
    });
    if (authorization.status === 'denied') {
      throw new AgentSystemToolError('approval_denied', authorization.reason);
    }

    const auditId = randomUUID();
    const startedAt = Date.now();
    const baseAudit = {
      action: operation.action,
      agentId,
      auditId,
      inputHash: inputHash(input),
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
      const childEnvironment: NodeJS.ProcessEnv = {};
      for (const name of baselineEnvironmentNames) {
        const value = this.#dependencies.baseEnvironment[name];
        if (value !== undefined) childEnvironment[name] = value;
      }
      Object.assign(
        childEnvironment,
        definition.runner.environment?.(resolvedConfiguration, { agentId, workspaceDir }) ?? {},
      );
      const secretValues: string[] = [];
      for (const [childName, binding] of Object.entries(
        definition.runner.credentialBindings?.(resolvedConfiguration) ?? {},
      )) {
        const value = values[binding];
        if (!value) {
          throw new AgentSystemToolError(
            'credential_unavailable',
            `The ${definition.id} tool credential ${binding} is unavailable for agent ${agentId}.`,
          );
        }
        childEnvironment[childName] = value;
        secretValues.push(value);
      }

      let cliResult: AgentSystemCliResult;
      try {
        cliResult = await this.#runCli({
          argv: definition.runner.argv(input, resolvedConfiguration),
          cwd: workspaceDir,
          environment: childEnvironment,
          executable: definition.runner.executable,
          excludedExecutableDirectories: [
            join(workspaceDir, 'bin'),
            ...(loaded.manifest.environment?.pathPrepend ?? []).map((path) =>
              resolve(workspaceDir, path),
            ),
            ...(this.#dependencies.excludedExecutableDirectories ?? []),
          ],
          maxOutputBytes: definition.runner.maxOutputBytes ?? 65_536,
          signal,
          timeoutMs: definition.runner.timeoutMs ?? 30_000,
        });
      } catch {
        throw new AgentSystemToolError(
          'tool_unavailable',
          `The ${definition.id} tool executable is unavailable.`,
        );
      }
      const redactedResult = {
        ...cliResult,
        stderr: redact(cliResult.stderr, secretValues),
        stdout: redact(cliResult.stdout, secretValues),
      };
      if (redactedResult.timedOut) {
        throw new AgentSystemToolError(
          'execution_timed_out',
          `The ${definition.id} tool request timed out.`,
        );
      }
      const output = definition.tool.normalize(redactedResult, resolvedConfiguration);
      const durationMs = Date.now() - startedAt;
      await this.#recordAudit({
        ...baseAudit,
        durationMs,
        phase: 'completed',
        status: 'ok',
        truncated: redactedResult.truncated,
      });
      this.#dependencies.logger.info(
        `tool_call_completed auditId=${quote(auditId)} tool=${quote(definition.id)} openClawTool=${quote(definition.tool.name)} agentId=${quote(agentId)} action=${quote(operation.action)} source=${quote(scope.source)} durationMs=${durationMs} truncated=${redactedResult.truncated}`,
      );
      return { auditId, operation, output };
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

  async #loadBoundManifest(scope: AgentSystemToolScope) {
    if (scope.source === 'tool') {
      const agentId = scope.toolContext?.agentId?.trim();
      const workspaceDir = scope.toolContext?.workspaceDir;
      if (!agentId || !workspaceDir) {
        throw new AgentSystemToolError(
          'agent_not_resolved',
          'Agent System could not resolve the active OpenClaw agent.',
        );
      }
      const result = await this.#dependencies.manifestService.loadForAgentId(agentId, 'cli');
      if (
        result.status !== 'loaded' ||
        resolve(result.scope.workspaceDir) !== resolve(workspaceDir)
      ) {
        throw new AgentSystemToolError(
          'agent_not_resolved',
          'Agent System could not bind the active OpenClaw agent to this workspace.',
        );
      }
      return result;
    }

    if (scope.agentId) {
      const result = await this.#dependencies.manifestService.loadForAgentId(scope.agentId, 'cli');
      if (result.status !== 'loaded' || result.manifest.agent.id !== scope.agentId) {
        throw new AgentSystemToolError(
          'agent_not_resolved',
          `Agent System could not resolve OpenClaw agent ${scope.agentId}.`,
        );
      }
      return result;
    }

    if (!scope.workspaceDir) {
      throw new AgentSystemToolError(
        'agent_not_resolved',
        'Agent System could not resolve the tool command workspace.',
      );
    }
    const discovered = await this.#dependencies.manifestService.loadForWorkspace(
      scope.workspaceDir,
      undefined,
      'cli',
    );
    if (discovered.status !== 'loaded') {
      throw new AgentSystemToolError(
        'agent_not_resolved',
        'Agent System could not resolve an agent manifest for this tool command.',
      );
    }
    const result = await this.#dependencies.manifestService.loadForAgentId(
      discovered.manifest.agent.id,
      'cli',
    );
    if (
      result.status !== 'loaded' ||
      resolve(result.scope.workspaceDir) !== resolve(discovered.scope.workspaceDir)
    ) {
      throw new AgentSystemToolError(
        'agent_not_resolved',
        'Agent System could not bind this tool command workspace to its OpenClaw agent.',
      );
    }
    return result;
  }

  async #recordAudit(event: AgentSystemAuditEvent): Promise<void> {
    await this.#dependencies.audit?.record(event);
  }
}
