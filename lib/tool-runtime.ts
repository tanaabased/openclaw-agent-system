import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import type { Static, TSchema } from 'typebox';

import resolveManifestValue from '../utils/resolve-manifest-value.ts';
import resolveToolWorkingDirectory from '../utils/resolve-tool-working-directory.ts';
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
  AgentSystemCliToolDefinition,
  AgentSystemCliResult,
  AgentSystemToolExecutionResult,
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
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'> &
    Partial<Pick<AgentManifestService, 'loadForCommandDirectory'>>;
  runCli?: typeof runToolCli;
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
    const authorizationMode = definition.authorization?.mode ?? 'agent-system';
    if (authorizationMode === 'agent-system') {
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
      let childWorkingDirectory = workspaceDir;
      if (definition.runner.workingDirectory) {
        try {
          childWorkingDirectory = await resolveToolWorkingDirectory(
            workspaceDir,
            definition.runner.workingDirectory(input, resolvedConfiguration, {
              ...(scope.source === 'command' && scope.workspaceDir
                ? { commandWorkingDirectory: scope.workspaceDir }
                : {}),
              source: scope.source,
              workspaceDir,
            }),
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

      const runRequest = (argv: string[], stdin?: string) =>
        this.#runCli({
          argv,
          cwd: childWorkingDirectory,
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
          ...(stdin === undefined ? {} : { stdin }),
          timeoutMs: definition.runner.timeoutMs ?? 30_000,
        });

      const sanitizeResult = (result: AgentSystemCliResult): AgentSystemCliResult => ({
        ...result,
        stderr: redact(result.stderr, secretValues),
        stdout: redact(result.stdout, secretValues),
      });

      try {
        const preflight = definition.runner.preflight?.(resolvedConfiguration);
        if (preflight) {
          const preflightResult = sanitizeResult(await runRequest(preflight.argv));
          if (preflightResult.timedOut) {
            throw new AgentSystemToolError(
              'execution_timed_out',
              `The ${definition.id} tool identity check timed out.`,
            );
          }
          preflight.validate(preflightResult);
        }
      } catch (error) {
        if (error instanceof AgentSystemToolError) throw error;
        throw new AgentSystemToolError(
          'tool_unavailable',
          `The ${definition.id} tool executable is unavailable.`,
        );
      }

      let cliResult: AgentSystemCliResult;
      try {
        cliResult = await runRequest(
          definition.runner.argv(input, resolvedConfiguration),
          definition.runner.stdin?.(input, resolvedConfiguration),
        );
      } catch {
        throw new AgentSystemToolError(
          'tool_unavailable',
          `The ${definition.id} tool executable is unavailable.`,
        );
      }
      const redactedResult = sanitizeResult(cliResult);
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
        status:
          redactedResult.exitCode === 0
            ? 'ok'
            : `exit-${redactedResult.exitCode === null ? 'unknown' : redactedResult.exitCode}`,
        truncated: redactedResult.truncated,
      });
      this.#dependencies.logger.info(
        `tool_call_completed auditId=${quote(auditId)} tool=${quote(definition.id)} openClawTool=${quote(definition.tool.name)} agentId=${quote(agentId)} action=${quote(operation.action)} source=${quote(scope.source)} durationMs=${durationMs} exitCode=${quote(redactedResult.exitCode ?? 'unknown')} truncated=${redactedResult.truncated}`,
      );
      return { auditId, commandResult: redactedResult, operation, output };
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
