import { join, resolve } from 'node:path';

import type { Static, TSchema } from 'typebox';

import type { AgentManifest } from '../utils/manifest-types.ts';
import resolveToolWorkingDirectory from '../utils/resolve-tool-working-directory.ts';
import AgentSystemToolError from './tool-error.ts';
import type {
  AgentSystemCliResult,
  AgentSystemCliRunRequest,
  AgentSystemCliToolDefinition,
  AgentSystemCliToolExecutionPayload,
  AgentSystemToolResourceLease,
  AgentSystemToolScope,
} from './tool-types.ts';

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
  runCli: (request: AgentSystemCliRunRequest) => Promise<AgentSystemCliResult>;
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
  const workingDirectoryScope = {
    ...(options.scope.source === 'command' && options.scope.workspaceDir
      ? { commandWorkingDirectory: options.scope.workspaceDir }
      : {}),
    source: options.scope.source,
    workspaceDir,
  } as const;
  let childWorkingDirectory = workspaceDir;
  if (options.definition.runner.workingDirectory) {
    try {
      const admitted =
        (await options.definition.runner.admittedWorkingDirectories?.(
          options.input,
          resolvedConfiguration,
          { source: options.scope.source, workspaceDir },
        )) ?? [];
      childWorkingDirectory = await resolveToolWorkingDirectory(
        workspaceDir,
        await options.definition.runner.workingDirectory(
          options.input,
          resolvedConfiguration,
          workingDirectoryScope,
        ),
        admitted,
      );
    } catch {
      throw new AgentSystemToolError(
        'invalid_arguments',
        `The ${options.definition.id} tool working directory is invalid.`,
      );
    }
  }

  await options.definition.runner.prepare?.(resolvedConfiguration, { agentId, workspaceDir });
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

    const runRequest = (argv: string[], stdin?: string) =>
      options.runCli({
        argv,
        cwd: childWorkingDirectory,
        environment: childEnvironment,
        executable: options.definition.runner.executable,
        excludedExecutableDirectories: [
          join(workspaceDir, 'bin'),
          ...(manifest.environment?.pathPrepend ?? []).map((path) => resolve(workspaceDir, path)),
          ...(options.excludedExecutableDirectories ?? []),
        ],
        maxOutputBytes: options.definition.runner.maxOutputBytes ?? 65_536,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(stdin === undefined ? {} : { stdin }),
        timeoutMs: options.definition.runner.timeoutMs ?? 30_000,
      });
    const sanitize = (result: AgentSystemCliResult): AgentSystemCliResult => ({
      ...result,
      stderr: redact(result.stderr, secretValues),
      stdout: redact(result.stdout, secretValues),
    });

    try {
      const preflight = options.definition.runner.preflight?.(resolvedConfiguration);
      if (preflight) {
        const result = sanitize(await runRequest(preflight.argv));
        if (result.timedOut) {
          throw new AgentSystemToolError(
            'execution_timed_out',
            `The ${options.definition.id} tool identity check timed out.`,
          );
        }
        preflight.validate(result);
      }
    } catch (error) {
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
          options.definition.runner.argv(options.input, resolvedConfiguration),
          options.definition.runner.stdin?.(options.input, resolvedConfiguration),
        ),
      );
    } catch {
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
