import GitHubRequestCooldown from './github-request-cooldown.ts';
import retryGitHubRead from './github-read-retry.ts';
import { parseGitHubApiResponse } from '../channels/github/provider/api-response.ts';
import {
  withProviderDiagnostic,
  providerDiagnostic,
  type ProviderDiagnostic,
} from '../utils/provider-diagnostic.ts';
import githubDiagnostic, { githubCliDiagnostic } from '../credentials/github-diagnostic.ts';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import type AgentEnvironmentService from '../environment/service.ts';
import type { ManifestLoadTrigger } from '../manifest/service.ts';
import type { AgentSystemCliResult, AgentSystemCliRunner } from '../api/types.ts';
import type { AgentManifest } from '../manifest/types.ts';
import resolveManifestValue from '../manifest/resolve-value.ts';
import githubCredentialRejected from '../credentials/github-rejection.ts';

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
  credentialMaterializer?: GitHubCredentialMaterializer;
  environmentService: Pick<AgentEnvironmentService, 'loadForWorkspace'> &
    Partial<Pick<AgentEnvironmentService, 'invalidateCredentials'>>;
  excludedExecutableDirectories?: readonly string[];
  runCli: AgentSystemCliRunner;
  retryRead?: typeof retryGitHubRead;
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

export interface GitHubAccountGitAuthor {
  email?: string;
  name?: string;
}

export interface GitHubAccountCredential {
  host: string;
  token: string;
}

export interface GitHubCredentialMaterializer {
  materialize(options: {
    credential: GitHubAccountCredential;
    directory: string;
    identity: GitHubAccountIdentity;
  }): Promise<void>;
}

export interface ConnectedGitHubAccountClient {
  /** Opaque lifetime for account-scoped provider observations; replaced on rebinding or rejection. */
  readonly observationScope?: object;
  credentialFingerprint?: string;
  execute(
    argv: string[],
    stdin?: string,
    options?: GitHubAccountExecutionOptions,
  ): Promise<AgentSystemCliResult>;
  gitAuthor?: GitHubAccountGitAuthor;
  identity: GitHubAccountIdentity;
  materializeCredential?(directory: string): Promise<void>;
  verifyConfiguredIdentity?(configDirectory: string): Promise<GitHubAccountIdentity>;
}

/** Identify stable credential, identity, and process failures at the shared GitHub boundary. */
export class GitHubAccountClientError extends Error {
  override name = 'GitHubAccountClientError';

  constructor(
    readonly code: string,
    message: string,
    _options?: ErrorOptions,
    readonly providerDiagnostic?: ProviderDiagnostic,
  ) {
    // Host error formatters traverse causes; retain only the safe provider evidence.
    super(withProviderDiagnostic(message, providerDiagnostic));
  }
}

function redact(result: AgentSystemCliResult, secret: string): AgentSystemCliResult {
  return {
    ...result,
    stderr: result.stderr.split(secret).join('[REDACTED]'),
    stdout: result.stdout.split(secret).join('[REDACTED]'),
  };
}

function connectionError(message: string, evidence?: ProviderDiagnostic): GitHubAccountClientError {
  return new GitHubAccountClientError(
    'github-account-credential-unavailable',
    message,
    undefined,
    evidence,
  );
}

function parseIdentity(result: AgentSystemCliResult): GitHubAccountIdentity {
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    throw new GitHubAccountClientError(
      'github-account-identity-failed',
      'The GitHub account identity check did not complete successfully.',
      undefined,
      githubCliDiagnostic(result, 'identity-check'),
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(
      result.stdout.startsWith('HTTP/')
        ? parseGitHubApiResponse(result.stdout).body
        : result.stdout,
    );
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
  readonly #runCli: AgentSystemCliRunner;
  readonly #retryRead: typeof retryGitHubRead;
  readonly #cooldown = new GitHubRequestCooldown();
  readonly #identities = new Map<
    string,
    { credentialFingerprint: string; identity?: GitHubAccountIdentity; observationScope: object }
  >();

  constructor(dependencies: GitHubAccountClientDependencies) {
    this.#dependencies = dependencies;
    this.#runCli = dependencies.runCli;
    this.#retryRead = dependencies.retryRead ?? retryGitHubRead;
  }

  async connect(
    context: { manifest: AgentManifest; workspaceDir: string },
    trigger: ManifestLoadTrigger = 'cli',
    signal?: AbortSignal,
  ): Promise<ConnectedGitHubAccountClient> {
    const configuration = context.manifest.github;
    if (!configuration?.username || !configuration.token) {
      throw connectionError(
        'GitHub access requires explicit username and token declarations.',
        providerDiagnostic('github', 'credential-resolve', 'missing-credential'),
      );
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
        loaded.diagnostics.find((entry) => entry.providerDiagnostic)?.providerDiagnostic,
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
        'The declared GitHub credential is unavailable.',
        providerDiagnostic('github', 'credential-resolve', 'missing-credential'),
      );
    }
    const normalizedToken = token.trim();
    if (!normalizedToken || normalizedToken.length > 2048 || /\s/u.test(normalizedToken)) {
      throw connectionError('The GitHub credential must contain one non-empty line.');
    }
    const credentialFingerprint = createHash('sha256').update(normalizedToken).digest('hex');
    const binding = JSON.stringify([
      resolve(context.workspaceDir),
      context.manifest.agent.id,
      (configuration.host ?? 'github.com').toLowerCase(),
      username.value.trim().toLowerCase(),
    ]);
    let verification = this.#identities.get(binding);
    if (verification?.credentialFingerprint !== credentialFingerprint) {
      verification = { credentialFingerprint, observationScope: {} };
      this.#identities.set(binding, verification);
    }

    const resolveOptionalValue = (
      value: AgentManifest['agent']['name'] | undefined,
      fieldPath: string,
    ) => {
      if (value === undefined) return undefined;
      const resolved = resolveManifestValue(value, loaded.environment.values, fieldPath);
      if (resolved.status === 'invalid') throw connectionError(resolved.diagnostic.message);
      return resolved.value.trim();
    };
    const gitName = resolveOptionalValue(
      context.manifest.git?.name ?? context.manifest.agent.name,
      context.manifest.git?.name === undefined ? '/agent/name' : '/git/name',
    );
    const gitEmail = resolveOptionalValue(
      context.manifest.git?.email ?? context.manifest.agent.email,
      context.manifest.git?.email === undefined ? '/agent/email' : '/git/email',
    );
    const gitAuthor =
      gitName === undefined && gitEmail === undefined
        ? undefined
        : {
            ...(gitEmail === undefined ? {} : { email: gitEmail }),
            ...(gitName === undefined ? {} : { name: gitName }),
          };

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
      GH_TOKEN: normalizedToken,
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
      const account = `${environment.GH_HOST}:${username.value.trim().toLowerCase()}`;
      const blocked = this.#cooldown.inspect(account, argv);
      if (blocked)
        throw new GitHubAccountClientError(
          'github-account-rate-limited',
          'GitHub requests are paused until the provider cooldown expires.',
          undefined,
          blocked,
        );
      const limits = normalizedExecutionOptions(options);
      const requestSignal = options?.signal ?? signal;
      try {
        const result = redact(
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
          normalizedToken,
        );
        this.#cooldown.observe(account, result);
        if (githubCredentialRejected(result)) {
          if (this.#identities.get(binding) === verification) this.#identities.delete(binding);
          this.#dependencies.environmentService.invalidateCredentials?.(context.manifest.agent.id);
        }
        return result;
      } catch (error) {
        throw new GitHubAccountClientError(
          'github-account-tool-unavailable',
          'The GitHub CLI executable is unavailable for authenticated GitHub access.',
          { cause: error },
          githubDiagnostic({}),
        );
      }
    };

    // The token's owner is stable. Actual operations still enforce current provider permissions.
    const identity = verification.identity
      ? { ...verification.identity }
      : parseIdentity(
          await this.#retryRead(
            (timeoutMs) =>
              execute(
                ['api', 'user', '--include', '--jq', '{login:.login,nodeId:.node_id}'],
                undefined,
                {
                  timeoutMs,
                },
              ),
            { signal },
          ),
        );
    if (identity.login.toLowerCase() !== username.value.trim().toLowerCase()) {
      this.#dependencies.environmentService.invalidateCredentials?.(context.manifest.agent.id);
      throw new GitHubAccountClientError(
        'github-account-identity-mismatch',
        `GitHub returned ${identity.login}, not the configured username ${username.value}.`,
      );
    }
    if (this.#identities.get(binding) === verification) verification.identity = { ...identity };

    const profileEnvironment = (configDirectory: string): NodeJS.ProcessEnv => ({
      ...environment,
      GH_CONFIG_DIR: resolve(configDirectory),
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    });
    const runProfileCli = async (
      argv: string[],
      configDirectory: string,
      stdin?: string,
      timeoutMs = defaultTimeoutMs,
    ): Promise<AgentSystemCliResult> => {
      try {
        return redact(
          await this.#runCli({
            argv,
            cwd: context.workspaceDir,
            environment: profileEnvironment(configDirectory),
            executable: 'gh',
            excludedExecutableDirectories,
            maxOutputBytes: defaultMaximumOutputBytes,
            ...(signal ? { signal } : {}),
            ...(stdin === undefined ? {} : { stdin }),
            timeoutMs,
          }),
          normalizedToken,
        );
      } catch {
        throw new GitHubAccountClientError(
          'github-account-profile-tool-unavailable',
          'The GitHub CLI executable is unavailable for managed profile setup.',
          undefined,
          githubDiagnostic({}, 'identity-check'),
        );
      }
    };
    const verifyConfiguredIdentity = async (configDirectory: string) => {
      let profileIdentity;
      try {
        profileIdentity = parseIdentity(
          await this.#retryRead(
            (timeoutMs) =>
              runProfileCli(
                ['api', 'user', '--include', '--jq', '{login:.login,nodeId:.node_id}'],
                configDirectory,
                undefined,
                timeoutMs,
              ),
            { signal },
          ),
        );
      } catch (error) {
        throw new GitHubAccountClientError(
          'github-account-profile-identity-failed',
          'GitHub rejected the managed profile identity check.',
          { cause: error },
          error instanceof GitHubAccountClientError
            ? (error.providerDiagnostic ?? githubDiagnostic({}, 'identity-check'))
            : githubDiagnostic({}, 'identity-check'),
        );
      }
      if (
        profileIdentity.login.toLowerCase() !== identity.login.toLowerCase() ||
        profileIdentity.nodeId !== identity.nodeId
      ) {
        throw new GitHubAccountClientError(
          'github-account-profile-identity-mismatch',
          'The managed GitHub profile resolves to a different account.',
        );
      }
      return profileIdentity;
    };
    const credentialMaterializer = this.#dependencies.credentialMaterializer;
    const materializeCredential = credentialMaterializer
      ? async (directory: string): Promise<void> =>
          credentialMaterializer.materialize({
            credential: {
              host: configuration.host ?? 'github.com',
              token: normalizedToken,
            },
            directory: resolve(directory),
            identity,
          })
      : undefined;

    return {
      observationScope: verification.observationScope,
      credentialFingerprint,
      execute,
      ...(gitAuthor === undefined ? {} : { gitAuthor }),
      identity: { ...identity },
      ...(materializeCredential === undefined ? {} : { materializeCredential }),
      verifyConfiguredIdentity,
    };
  }
}
