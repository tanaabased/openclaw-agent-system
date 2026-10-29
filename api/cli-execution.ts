import type { Static, TSchema } from 'typebox';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import cliOutputComplete from './cli-output-complete.ts';
import type { AgentManifest } from '../manifest/types.ts';
import resolveToolWorkingDirectory from './resolve-working-directory.ts';
import { excludedToolExecutableDirectories } from './executable-requirements.ts';
import AgentSystemToolError from './error.ts';
import { managedCommandTimeoutMs, metadataCommandTimeoutMs } from './cli-budget.ts';
import isManagedWorktreeWorkspace from '../tools/git/worktree-workspace.ts';
import type {
  AgentSystemCliResult,
  AgentSystemCliRunner,
  AgentSystemCliToolDefinition,
  AgentSystemCliToolExecutionPayload,
  AgentSystemToolResourceLease,
  AgentSystemToolScope,
} from './types.ts';

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

interface ExecuteAgentSystemCliToolOptions<
  TParameters extends TSchema,
  TDeclaredConfiguration,
  TResolvedConfiguration,
  TOutput,
> {
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  context: {
    agentId: string;
    manifest: AgentManifest;
    resolvedConfiguration: TResolvedConfiguration;
    values: Readonly<Record<string, string>>;
    workspaceDir: string;
  };
  definition: AgentSystemCliToolDefinition<
    TParameters,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    TOutput
  >;
  excludedExecutableDirectories?: readonly string[];
  input: Static<TParameters>;
  runCli: AgentSystemCliRunner;
  now?: () => number;
  scope: AgentSystemToolScope;
  signal?: AbortSignal;
}

function bindingNames(binding: string | { anyOf: readonly string[] }): readonly string[] {
  return typeof binding === 'string' ? [binding] : binding.anyOf;
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (output, secret) => (secret ? output.split(secret).join('[REDACTED]') : output),
    value,
  );
}

/** Execute one authorized command-backed tool with invocation-scoped credentials and resources. */
export default async function executeAgentSystemCliTool<
  TParameters extends TSchema,
  TDeclaredConfiguration,
  TResolvedConfiguration,
  TOutput,
>(
  options: ExecuteAgentSystemCliToolOptions<
    TParameters,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    TOutput
  >,
): Promise<AgentSystemCliToolExecutionPayload<TOutput>> {
  const { agentId, manifest, resolvedConfiguration, values, workspaceDir } = options.context;
  const now = options.now ?? (() => performance.now());
  const configuredTimeout = options.definition.runner.timeoutMs;
  const timeoutMs =
    typeof configuredTimeout === 'function'
      ? configuredTimeout(options.input, resolvedConfiguration)
      : (configuredTimeout ?? managedCommandTimeoutMs);
  const deadline = options.scope.executionDeadline ?? now() + timeoutMs;
  // native execution context was verified by manifest binding before credential resolution.
  const executionWorkingDirectory =
    options.scope.source === 'tool' ? options.scope.toolContext?.workspaceDir : undefined;
  if (
    executionWorkingDirectory &&
    resolve(executionWorkingDirectory) !== resolve(workspaceDir) &&
    !(await isManagedWorktreeWorkspace(
      workspaceDir,
      manifest.git?.worktrees,
      executionWorkingDirectory,
    ))
  )
    throw new AgentSystemToolError(
      'agent_not_resolved',
      'The managed execution workspace changed before command execution.',
    );
  const workingDirectoryScope = {
    ...(executionWorkingDirectory ? { executionWorkingDirectory } : {}),
    ...(options.scope.source === 'agent-command' && options.scope.admittedWorkingDirectories
      ? { admittedWorkingDirectories: options.scope.admittedWorkingDirectories }
      : {}),
    ...(options.scope.source !== 'tool' && options.scope.workspaceDir
      ? { commandWorkingDirectory: options.scope.workspaceDir }
      : {}),
    source: options.scope.source,
    workspaceDir,
  } as const;
  let childWorkingDirectory = executionWorkingDirectory ?? workspaceDir;
  if (options.definition.runner.workingDirectory) {
    try {
      const requestedDirectory = await options.definition.runner.workingDirectory(
        options.input,
        resolvedConfiguration,
        workingDirectoryScope,
      );
      if (requestedDirectory === undefined) {
        childWorkingDirectory = executionWorkingDirectory ?? workspaceDir;
      } else {
        const admitted =
          (await options.definition.runner.admittedWorkingDirectories?.(
            options.input,
            resolvedConfiguration,
            { source: options.scope.source, workspaceDir },
          )) ?? [];
        childWorkingDirectory = await resolveToolWorkingDirectory(
          workspaceDir,
          requestedDirectory,
          [
            ...(executionWorkingDirectory ? [executionWorkingDirectory] : []),
            ...(options.scope.source === 'agent-command'
              ? (options.scope.admittedWorkingDirectories ?? [])
              : []),
            ...admitted,
          ],
        );
      }
    } catch {
      throw new AgentSystemToolError(
        'invalid_arguments',
        `The ${options.definition.id} tool working directory is invalid.`,
      );
    }
  }

  await options.definition.runner.prepare?.(resolvedConfiguration, {
    agentId,
    workspaceDir,
    ...(options.scope.configurationMode
      ? { configurationMode: options.scope.configurationMode }
      : {}),
  });
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const name of baselineEnvironmentNames) {
    const value = options.baseEnvironment[name];
    if (value !== undefined) childEnvironment[name] = value;
  }
  Object.assign(
    childEnvironment,
    options.definition.runner.environment?.(resolvedConfiguration, {
      agentId,
      source: options.scope.source,
      ...(options.scope.terminalColumns === undefined
        ? {}
        : { terminalColumns: options.scope.terminalColumns }),
      workspaceDir,
    }) ?? {},
  );
  const secretValues: string[] = [];
  for (const [childName, binding] of Object.entries(
    options.definition.runner.credentialBindings?.(resolvedConfiguration) ?? {},
  )) {
    const names = bindingNames(binding);
    const selectedName = names.find((name) => Boolean(values[name]));
    const value = selectedName ? values[selectedName] : undefined;
    if (!value) {
      throw new AgentSystemToolError(
        'credential_unavailable',
        `The ${options.definition.id} tool credential ${names.join(' or ')} is unavailable for agent ${agentId}.`,
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
        `The ${options.definition.id} tool could not clean up invocation resources.`,
      );
    }
  };

  try {
    resourceLease = await options.definition.runner.acquireResources?.(
      options.input,
      resolvedConfiguration,
      {
        agentId,
        admittedWorkingDirectories: options.scope.admittedWorkingDirectories,
        resolveEnvironment(name) {
          return values[name];
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        source: options.scope.source,
        workspaceDir,
      },
    );
    if (resourceLease) {
      Object.assign(childEnvironment, resourceLease.environment);
      secretValues.push(...(resourceLease.sensitiveValues ?? []));
    }

    const throwIfCancelled = () => {
      if (options.signal?.aborted)
        throw new AgentSystemToolError(
          'execution_cancelled',
          `The ${options.definition.id} tool request was cancelled.`,
        );
    };
    const runRequest = async (argv: string[], stdin?: string, control = false) => {
      throwIfCancelled();
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0)
        throw new AgentSystemToolError(
          'execution_timed_out',
          'The managed command execution budget is exhausted.',
        );
      const result = await options.runCli({
        argv,
        cwd: childWorkingDirectory,
        environment: childEnvironment,
        executable: options.definition.runner.executable,
        excludedExecutableDirectories: excludedToolExecutableDirectories(
          manifest,
          workspaceDir,
          options.excludedExecutableDirectories,
        ),
        ...(options.definition.runner.maxOutputBytes === undefined
          ? {}
          : { maxOutputBytes: options.definition.runner.maxOutputBytes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(stdin === undefined ? {} : { stdin }),
        timeoutMs: control ? Math.min(metadataCommandTimeoutMs, remaining) : remaining,
      });
      throwIfCancelled();
      if (control && !result.timedOut && !cliOutputComplete(result))
        throw new AgentSystemToolError(
          'execution_failed',
          'The command returned incomplete control data.',
        );
      return result;
    };
    const sanitize = (result: AgentSystemCliResult): AgentSystemCliResult => ({
      ...result,
      stderr: redact(result.stderr, secretValues),
      stdout: redact(result.stdout, secretValues),
    });

    let preparedRequest: { argv: string[]; stdin?: string } | undefined;
    try {
      const preflight = options.definition.runner.preflight?.(resolvedConfiguration);
      if (preflight) {
        const result = sanitize(await runRequest(preflight.argv, undefined, true));
        if (result.timedOut) {
          throw new AgentSystemToolError(
            'execution_timed_out',
            `The ${options.definition.id} tool identity check timed out.`,
          );
        }
        preflight.validate(result);
      }
      preparedRequest = await options.definition.runner.prepareRequest?.(
        options.input,
        resolvedConfiguration,
        {
          credentialScope: createHash('sha256')
            .update(JSON.stringify([agentId, workspaceDir, secretValues]))
            .digest('hex'),
          cwd: childWorkingDirectory,
          async run(argv, stdin) {
            const result = sanitize(await runRequest(argv, stdin, true));
            if (result.timedOut) {
              throw new AgentSystemToolError(
                'execution_timed_out',
                `The ${options.definition.id} tool preflight timed out.`,
              );
            }
            return result;
          },
        },
      );
    } catch (error) {
      throwIfCancelled();
      if (error instanceof AgentSystemToolError) throw error;
      throw new AgentSystemToolError(
        'tool_unavailable',
        `The ${options.definition.id} tool executable is unavailable.`,
      );
    }

    let commandResult: AgentSystemCliResult;
    try {
      commandResult = sanitize(
        await runRequest(
          preparedRequest?.argv ??
            options.definition.runner.argv(options.input, resolvedConfiguration),
          preparedRequest
            ? preparedRequest.stdin
            : options.definition.runner.stdin?.(options.input, resolvedConfiguration),
        ),
      );
    } catch (error) {
      throwIfCancelled();
      if (error instanceof AgentSystemToolError) throw error;
      throw new AgentSystemToolError(
        'tool_unavailable',
        `The ${options.definition.id} tool executable is unavailable.`,
      );
    }
    if (commandResult.timedOut) {
      throw new AgentSystemToolError(
        'execution_timed_out',
        `The ${options.definition.id} tool request timed out.`,
      );
    }
    const output = options.definition.tool.normalize(commandResult, resolvedConfiguration);
    await disposeResources();
    return { commandResult, kind: 'cli', output };
  } catch (error) {
    await disposeResources();
    throw error;
  }
}
