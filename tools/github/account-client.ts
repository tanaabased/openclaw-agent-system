import { join, resolve } from 'node:path';

import type AgentEnvironmentService from '../../lib/agent-environment-service.ts';
import runToolCli from '../../lib/tool-cli-runner.ts';
import type { AgentSystemCliResult } from '../../lib/tool-types.ts';
import resolveManifestValue from '../../utils/resolve-manifest-value.ts';
import type { AgentManifest } from '../../utils/manifest-types.ts';
import type GitHubConfigStore from './config-store.ts';
import { GitHubAccountKeyError } from './account-key-service.ts';

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

export interface GitHubAccountClientDependencies {
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  configStore: Pick<GitHubConfigStore, 'configDirectory'>;
  environmentService: Pick<AgentEnvironmentService, 'loadForWorkspace'>;
  excludedExecutableDirectories?: readonly string[];
  runCli?: typeof runToolCli;
}

export interface ConnectedGitHubAccountClient {
  execute(argv: string[], stdin?: string): Promise<AgentSystemCliResult>;
}

function redact(result: AgentSystemCliResult, secret: string): AgentSystemCliResult {
  return {
    ...result,
    stderr: result.stderr.split(secret).join('[REDACTED]'),
    stdout: result.stdout.split(secret).join('[REDACTED]'),
  };
}

function connectionError(message: string): GitHubAccountKeyError {
  return new GitHubAccountKeyError('github-account-key-credential-unavailable', message);
}

/** Bind fixed lifecycle API calls to one manifest-declared GitHub account and child process. */
export default class GitHubAccountClient {
  readonly #dependencies: GitHubAccountClientDependencies;
  readonly #runCli: typeof runToolCli;

  constructor(dependencies: GitHubAccountClientDependencies) {
    this.#dependencies = dependencies;
    this.#runCli = dependencies.runCli ?? runToolCli;
  }

  async connect(context: {
    manifest: AgentManifest;
    workspaceDir: string;
  }): Promise<ConnectedGitHubAccountClient> {
    const configuration = context.manifest.github;
    if (!configuration?.username || !configuration.token) {
      throw connectionError(
        'GitHub account key management requires explicit username and token declarations.',
      );
    }
    const loaded = await this.#dependencies.environmentService.loadForWorkspace(
      context.workspaceDir,
      context.manifest.agent.id,
      'cli',
    );
    if (loaded.status !== 'loaded') {
      const diagnostic = loaded.diagnostics.find(({ severity }) => severity === 'error');
      throw connectionError(
        diagnostic?.message ?? 'The GitHub account key environment could not be resolved.',
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
        `The GitHub account key credential ${configuration.token} is unavailable for agent ${context.manifest.agent.id}.`,
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
    const execute = async (argv: string[], stdin?: string) => {
      try {
        return redact(
          await this.#runCli({
            argv,
            cwd: context.workspaceDir,
            environment,
            executable: 'gh',
            excludedExecutableDirectories,
            maxOutputBytes: 65_536,
            ...(stdin === undefined ? {} : { stdin }),
            timeoutMs: 30_000,
          }),
          token,
        );
      } catch (error) {
        throw new GitHubAccountKeyError(
          'github-account-key-tool-unavailable',
          'The GitHub CLI executable is unavailable for account key management.',
          { cause: error },
        );
      }
    };

    const identity = await execute(['api', 'user', '--jq', '.login']);
    if (identity.exitCode !== 0 || identity.timedOut || identity.truncated) {
      throw new GitHubAccountKeyError(
        'github-account-key-identity-failed',
        'GitHub rejected the account key identity check.',
      );
    }
    const actualUsername = identity.stdout.trim();
    if (actualUsername.toLowerCase() !== username.value.trim().toLowerCase()) {
      throw new GitHubAccountKeyError(
        'github-account-key-identity-mismatch',
        `GitHub returned ${actualUsername || 'an unknown user'}, not the configured username ${username.value}.`,
      );
    }
    return { execute };
  }
}
