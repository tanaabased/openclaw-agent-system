import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import type { Static, TSchema } from 'typebox';

import resolveManifestValue from '../utils/resolve-manifest-value.ts';
import resolveToolWorkingDirectory from '../utils/resolve-tool-working-directory.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import type AgentEnvironmentService from './agent-environment-service.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import AgentSystemToolError from './tool-error.ts';
import loadBoundToolManifest from './tool-manifest-binding.ts';
import {
  hashAgentSystemToolInput,
  type default as AgentSystemToolApprovalReceiptStore,
} from './tool-approval-receipt-store.ts';
import runToolCli from './tool-cli-runner.ts';
import type {
  AgentSystemAuditEvent,
  AgentSystemAuthorizationDecision,
  AgentSystemAuthorizationRequest,
  AgentSystemCliResult,
  AgentSystemCliToolDefinition,
  AgentSystemOperation,
  AgentSystemSemanticToolDefinition,
  AgentSystemToolExecutionResult,
  AgentSystemToolResourceLease,
  AgentSystemToolScope,
} from './tool-types.ts';

interface ToolLogger {
  error(message: string): void;
  info(message: string): void;
}

export interface AgentSystemToolRuntimeDependencies {
  approvals?: Pick<AgentSystemToolApprovalReceiptStore, 'consume'>;
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

const baselineEnvironmentNames = [
  'HOME',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
  'PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TERM',
] as const;

function bindingNames(binding: string | { anyOf: readonly string[] }): readonly string[] {
  return typeof binding === 'string' ? [binding] : binding.anyOf;
}

function quote(value: string | number): string {
  return JSON.stringify(value);
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

function emptyCommandResult(stdout = ''): AgentSystemCliResult {
  return {
    exitCode: 0,
    stderr: '',
    stdout,
    timedOut: false,
    truncated: false,
  };
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
  ): Promise<AgentSystemToolExecutionResult> {
    return this.#execute(definition, input, scope, async (context) => {
      const { agentId, manifest, resolvedConfiguration, values, workspaceDir } = context;
      const workingDirectoryScope = {
        ...(scope.source === 'command' && scope.workspaceDir
          ? { commandWorkingDirectory: scope.workspaceDir }
          : {}),
        source: scope.source,
        workspaceDir,
      } as const;
      let childWorkingDirectory = workspaceDir;
      if (definition.runner.workingDirectory) {
        try {
          const admitted =
            (await definition.runner.admittedWorkingDirectories?.(input, resolvedConfiguration, {
              workspaceDir,
            })) ?? [];
          childWorkingDirectory = await resolveToolWorkingDirectory(
            workspaceDir,
            await definition.runner.workingDirectory(
              input,
              resolvedConfiguration,
              workingDirectoryScope,
            ),
            admitted,
          );
        } catch {
          throw new AgentSystemToolError(
            'invalid_arguments',
            `The ${definition.id} tool working directory is invalid.`,
          );
        }
      }

      await definition.runner.prepare?.(resolvedConfiguration, { agentId, workspaceDir });
      const childEnvironment: NodeJS.ProcessEnv = {};
      for (const name of baselineEnvironmentNames) {
        const value = this.#dependencies.baseEnvironment[name];
        if (value !== undefined) childEnvironment[name] = value;
      }
      Object.assign(
        childEnvironment,
        definition.runner.environment?.(resolvedConfiguration, {
          agentId,
          source: scope.source,
          ...(scope.terminalColumns === undefined
            ? {}
            : { terminalColumns: scope.terminalColumns }),
          workspaceDir,
        }) ?? {},
      );
      const secretValues: string[] = [];
      for (const [childName, binding] of Object.entries(
        definition.runner.credentialBindings?.(resolvedConfiguration) ?? {},
      )) {
        const names = bindingNames(binding);
        const selectedName = names.find((name) => Boolean(values[name]));
        const value = selectedName ? values[selectedName] : undefined;
        if (!value) {
          throw new AgentSystemToolError(
            'credential_unavailable',
            `The ${definition.id} tool credential ${names.join(' or ')} is unavailable for agent ${agentId}.`,
          );
        }
        childEnvironment[childName] = value;
        secretValues.push(value);
      }

      let resourceLease: AgentSystemToolResourceLease | undefined;
      const disposeResources = async () => {
        const lease = resourceLease;
        resourceLease = undefined;
        if (!lease) return;
        try {
          await lease.dispose();
        } catch {
          throw new AgentSystemToolError(
            'resource_cleanup_failed',
            `The ${definition.id} tool could not clean up invocation resources.`,
          );
        }
      };
      try {
        resourceLease = await definition.runner.acquireResources?.(input, resolvedConfiguration, {
          agentId,
          resolveEnvironment(name) {
            return values[name];
          },
          ...(signal === undefined ? {} : { signal }),
          source: scope.source,
          workspaceDir,
        });
        if (resourceLease) {
          Object.assign(childEnvironment, resourceLease.environment);
          secretValues.push(...(resourceLease.sensitiveValues ?? []));
        }

        const runRequest = (argv: string[], stdin?: string) =>
          this.#runCli({
            argv,
            cwd: childWorkingDirectory,
            environment: childEnvironment,
            executable: definition.runner.executable,
            excludedExecutableDirectories: [
              join(workspaceDir, 'bin'),
              ...(manifest.environment?.pathPrepend ?? []).map((path) =>
                resolve(workspaceDir, path),
              ),
              ...(this.#dependencies.excludedExecutableDirectories ?? []),
            ],
            maxOutputBytes: definition.runner.maxOutputBytes ?? 65_536,
            ...(signal === undefined ? {} : { signal }),
            ...(stdin === undefined ? {} : { stdin }),
            timeoutMs: definition.runner.timeoutMs ?? 30_000,
          });
        const sanitize = (result: AgentSystemCliResult): AgentSystemCliResult => ({
          ...result,
          stderr: redact(result.stderr, secretValues),
          stdout: redact(result.stdout, secretValues),
        });

        try {
          const preflight = definition.runner.preflight?.(resolvedConfiguration);
          if (preflight) {
            const result = sanitize(await runRequest(preflight.argv));
            if (result.timedOut) {
              throw new AgentSystemToolError(
                'execution_timed_out',
                `The ${definition.id} tool identity check timed out.`,
              );
            }
            preflight.validate(result);
          }
        } catch (error) {
          if (error instanceof AgentSystemToolError) throw error;
          throw new AgentSystemToolError(
            'tool_unavailable',
            `The ${definition.id} tool executable is unavailable.`,
          );
        }

        let commandResult: AgentSystemCliResult;
        try {
          commandResult = sanitize(
            await runRequest(
              definition.runner.argv(input, resolvedConfiguration),
              definition.runner.stdin?.(input, resolvedConfiguration),
            ),
          );
        } catch {
          throw new AgentSystemToolError(
            'tool_unavailable',
            `The ${definition.id} tool executable is unavailable.`,
          );
        }
        if (commandResult.timedOut) {
          throw new AgentSystemToolError(
            'execution_timed_out',
            `The ${definition.id} tool request timed out.`,
          );
        }
        const output = definition.tool.normalize(commandResult, resolvedConfiguration);
        await disposeResources();
        return { commandResult, output };
      } catch (error) {
        await disposeResources();
        throw error;
      }
    });
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
  ): Promise<AgentSystemToolExecutionResult> {
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
      const serialized = JSON.stringify(output, undefined, 2);
      return {
        commandResult: emptyCommandResult(
          scope.source === 'command' && serialized !== undefined ? `${serialized}\n` : '',
        ),
        output,
      };
    });
  }

  async #execute<TParameters extends TSchema, TDeclaredConfiguration, TResolvedConfiguration>(
    definition: RuntimeDefinition<TParameters, TDeclaredConfiguration, TResolvedConfiguration>,
    input: Static<TParameters>,
    scope: AgentSystemToolScope,
    perform: (
      context: RuntimeExecutionContext<TResolvedConfiguration>,
    ) => Promise<{ commandResult: AgentSystemCliResult; output: unknown }>,
  ): Promise<AgentSystemToolExecutionResult> {
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
    if ((definition.authorization?.mode ?? 'agent-system') === 'agent-system') {
      const request = {
        agentId,
        operation,
        toolId: definition.id,
        toolName: definition.tool.name,
      };
      const authorization = definition.authorization?.authorize
        ? await definition.authorization.authorize(operation, declaredConfiguration)
        : await (this.#dependencies.authorize ?? defaultAuthorize)(request);
      if (authorization.status === 'approval_required') {
        const toolCallId = scope.toolCallId?.trim();
        const approved =
          scope.source === 'tool' &&
          Boolean(toolCallId) &&
          Boolean(
            this.#dependencies.approvals?.consume({
              agentId,
              input,
              toolCallId: toolCallId ?? '',
              toolId: definition.id,
            }),
          );
        if (!approved) throw new AgentSystemToolError('approval_denied', authorization.reason);
      }
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
    }

    const auditId = randomUUID();
    const startedAt = Date.now();
    const baseAudit = {
      action: operation.action,
      agentId,
      auditId,
      inputHash: hashAgentSystemToolInput(input),
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
      const exitCode = result.commandResult.exitCode;
      await this.#recordAudit({
        ...baseAudit,
        durationMs,
        phase: 'completed',
        status: exitCode === 0 ? 'ok' : `exit-${exitCode === null ? 'unknown' : exitCode}`,
        truncated: result.commandResult.truncated,
      });
      this.#dependencies.logger.info(
        `tool_call_completed auditId=${quote(auditId)} tool=${quote(definition.id)} openClawTool=${quote(definition.tool.name)} agentId=${quote(agentId)} action=${quote(operation.action)} source=${quote(scope.source)} durationMs=${durationMs} exitCode=${quote(exitCode ?? 'unknown')} truncated=${result.commandResult.truncated}`,
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
