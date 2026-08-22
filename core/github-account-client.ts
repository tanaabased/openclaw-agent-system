import { join, resolve } from 'node:path';

import type AgentEnvironmentService from '../environment/service.ts';
import type { ManifestLoadTrigger } from '../manifest/service.ts';
import runToolCli from '../api/cli-runner.ts';
import type { AgentSystemCliResult } from '../api/types.ts';
import type { AgentManifest } from '../manifest/types.ts';
import resolveManifestValue from '../manifest/resolve-value.ts';

const baselineEnvironmentNames = [
  'HOME',
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
] as const;
const defaultMaximumOutputBytes = 65_536;
const maximumOutputBytes = 1024 * 1024;
const defaultTimeoutMs = 30_000;

export interface GitHubAccountClientDependencies {
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  configStore: { configDirectory(agentId: string): string };
  environmentService: Pick<AgentEnvironmentService, 'loadForWorkspace'>;
  excludedExecutableDirectories?: readonly string[];
  runCli?: typeof runToolCli;
}

export interface GitHubAccountExecutionOptions {
  maxOutputBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GitHubAccountIdentity {
  login: string;
  nodeId: string;
}

export interface ConnectedGitHubAccountClient {
  execute(
    argv: string[],
    stdin?: string,
    options?: GitHubAccountExecutionOptions,
  ): Promise<AgentSystemCliResult>;
  identity: GitHubAccountIdentity;
}

/** Identify stable credential, identity, and process failures at the shared GitHub boundary. */
export class GitHubAccountClientError extends Error {
  override name = 'GitHubAccountClientError';

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function redact(result: AgentSystemCliResult, secret: string): AgentSystemCliResult {
  return {
    ...result,
    stderr: result.stderr.split(secret).join('[REDACTED]'),
    stdout: result.stdout.split(secret).join('[REDACTED]'),
  };
}

function connectionError(message: string): GitHubAccountClientError {
  return new GitHubAccountClientError('github-account-credential-unavailable', message);
}

function parseIdentity(result: AgentSystemCliResult): GitHubAccountIdentity {
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    throw new GitHubAccountClientError(
      'github-account-identity-failed',
      'GitHub rejected the account identity check.',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new GitHubAccountClientError(
      'github-account-identity-invalid',
      'GitHub returned invalid account identity data.',
      { cause: error },
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubAccountClientError(
      'github-account-identity-invalid',
      'GitHub returned invalid account identity data.',
    );
  }
  const identity = value as Record<string, unknown>;
  const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
  if (
    typeof identity.login !== 'string' ||
    !loginPattern.test(identity.login) ||
    typeof identity.nodeId !== 'string' ||
    identity.nodeId.length > 255 ||
    identity.nodeId.includes('\0') ||
    /\s/u.test(identity.nodeId)
  ) {
    throw new GitHubAccountClientError(
      'github-account-identity-invalid',
      'GitHub returned incomplete account identity data.',
    );
  }
  return { login: identity.login.trim(), nodeId: identity.nodeId.trim() };
}

function normalizedExecutionOptions(options: GitHubAccountExecutionOptions | undefined): {
  maxOutputBytes: number;
  timeoutMs: number;
} {
  const requestedMaximum = Number.isFinite(options?.maxOutputBytes)
    ? (options?.maxOutputBytes ?? defaultMaximumOutputBytes)
    : defaultMaximumOutputBytes;
  const requestedTimeout = Number.isFinite(options?.timeoutMs)
    ? (options?.timeoutMs ?? defaultTimeoutMs)
    : defaultTimeoutMs;
  return {
    maxOutputBytes: Math.max(1, Math.min(maximumOutputBytes, Math.floor(requestedMaximum))),
    timeoutMs: Math.max(1, Math.min(120_000, Math.floor(requestedTimeout))),
  };
}

/** Bind fixed internal calls to one manifest-declared GitHub account and sanitized process. */
export default class GitHubAccountClient {
  readonly #dependencies: GitHubAccountClientDependencies;
  readonly #runCli: typeof runToolCli;

  constructor(dependencies: GitHubAccountClientDependencies) {
    this.#dependencies = dependencies;
    this.#runCli = dependencies.runCli ?? runToolCli;
  }

  async connect(
    context: { manifest: AgentManifest; workspaceDir: string },
    trigger: ManifestLoadTrigger = 'cli',
    signal?: AbortSignal,
  ): Promise<ConnectedGitHubAccountClient> {
    const configuration = context.manifest.github;
    if (!configuration?.username || !configuration.token) {
      throw connectionError('GitHub access requires explicit username and token declarations.');
    }
    const loaded = await this.#dependencies.environmentService.loadForWorkspace(
      context.workspaceDir,
      context.manifest.agent.id,
      trigger,
    );
    if (loaded.status !== 'loaded') {
      const diagnostic = loaded.diagnostics.find(({ severity }) => severity === 'error');
      throw connectionError(
        diagnostic?.message ?? 'The GitHub account environment could not be resolved.',
      );
    }

    const username = resolveManifestValue(
      configuration.username,
      loaded.environment.values,
      '/github/username',
    );
    if (username.status === 'invalid') throw connectionError(username.diagnostic.message);
    const token = loaded.environment.values[configuration.token];
    if (!token) {
      throw connectionError(
        `The GitHub credential ${configuration.token} is unavailable for agent ${context.manifest.agent.id}.`,
      );
    }

    const environment: NodeJS.ProcessEnv = {};
    for (const name of baselineEnvironmentNames) {
      const value = this.#dependencies.baseEnvironment[name];
      if (value !== undefined) environment[name] = value;
    }
    Object.assign(environment, {
      GH_CONFIG_DIR: this.#dependencies.configStore.configDirectory(context.manifest.agent.id),
      GH_HOST: configuration.host ?? 'github.com',
      GH_PAGER: 'cat',
      GH_PROMPT_DISABLED: '1',
      GH_TOKEN: token,
      PAGER: 'cat',
    });
    const excludedExecutableDirectories = [
      join(context.workspaceDir, 'bin'),
      ...(context.manifest.environment?.pathPrepend ?? []).map((path) =>
        resolve(context.workspaceDir, path),
      ),
      ...(this.#dependencies.excludedExecutableDirectories ?? []),
    ];
    const execute = async (
      argv: string[],
      stdin?: string,
      options?: GitHubAccountExecutionOptions,
    ) => {
      const limits = normalizedExecutionOptions(options);
      const requestSignal = options?.signal ?? signal;
      try {
        return redact(
          await this.#runCli({
            argv,
            cwd: context.workspaceDir,
            environment,
            executable: 'gh',
            excludedExecutableDirectories,
            maxOutputBytes: limits.maxOutputBytes,
            ...(requestSignal ? { signal: requestSignal } : {}),
            ...(stdin === undefined ? {} : { stdin }),
            timeoutMs: limits.timeoutMs,
          }),
          token,
        );
      } catch (error) {
        throw new GitHubAccountClientError(
          'github-account-tool-unavailable',
          'The GitHub CLI executable is unavailable for authenticated GitHub access.',
          { cause: error },
        );
      }
    };

    const identity = parseIdentity(
      await execute(['api', 'user', '--jq', '{login:.login,nodeId:.node_id}']),
    );
    if (identity.login.toLowerCase() !== username.value.trim().toLowerCase()) {
      throw new GitHubAccountClientError(
        'github-account-identity-mismatch',
        `GitHub returned ${identity.login}, not the configured username ${username.value}.`,
      );
    }
    return { execute, identity };
  }
}
