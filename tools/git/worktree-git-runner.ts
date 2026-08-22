import runToolCli from '../../api/cli-runner.ts';
import AgentSystemToolError from '../../api/error.ts';
import type { GitSshConfiguration } from './config-schema.ts';
import { gitIdentityEnvironment, type ResolvedGitIdentity } from './identity.ts';
import type GitSshResourceService from './ssh-resource-service.ts';
import type { GitWorktreeGitRunner } from './worktree-service.ts';

const environmentNames = [
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

export interface GitWorktreeGitRunnerConfiguration {
  externalExtensions: string[];
  identity: ResolvedGitIdentity;
  ssh?: GitSshConfiguration;
}

export interface GitWorktreeGitRunnerFactoryDependencies {
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  excludedExecutableDirectories?: readonly string[];
  runCli?: typeof runToolCli;
  sshResourceService?: Pick<GitSshResourceService, 'acquire'>;
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (output, secret) => (secret ? output.split(secret).join('[REDACTED]') : output),
    value,
  );
}

/** Create one invocation-scoped fixed Git runner and dispose its SSH resources. */
export default class GitWorktreeGitRunnerFactory {
  readonly #dependencies: GitWorktreeGitRunnerFactoryDependencies;
  readonly #runCli: typeof runToolCli;

  constructor(dependencies: GitWorktreeGitRunnerFactoryDependencies) {
    this.#dependencies = dependencies;
    this.#runCli = dependencies.runCli ?? runToolCli;
  }

  async acquire(
    configuration: GitWorktreeGitRunnerConfiguration,
    scope: {
      resolveEnvironment(name: string): string | undefined;
      signal?: AbortSignal;
      workspaceDir: string;
    },
    options: { authentication?: boolean } = {},
  ): Promise<{ dispose(): Promise<void>; git: GitWorktreeGitRunner }> {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of environmentNames) {
      const value = this.#dependencies.baseEnvironment[name];
      if (value !== undefined) environment[name] = value;
    }
    Object.assign(
      environment,
      gitIdentityEnvironment(
        configuration.identity,
        process.platform,
        configuration.externalExtensions,
      ),
    );

    const authentication = options.authentication === true ? configuration.ssh : undefined;
    const resource = authentication
      ? await this.#dependencies.sshResourceService?.acquire(
          { authentication },
          {
            resolveEnvironment: scope.resolveEnvironment,
            ...(scope.signal === undefined ? {} : { signal: scope.signal }),
            workspaceDir: scope.workspaceDir,
          },
        )
      : undefined;
    if (authentication && !resource) {
      throw new AgentSystemToolError(
        'credential_unavailable',
        'Git SSH authentication is unavailable in this runtime.',
      );
    }
    Object.assign(environment, resource?.environment);
    const secrets = resource?.sensitiveValues ?? [];

    return {
      async dispose() {
        await resource?.dispose();
      },
      git: {
        run: async (input) => {
          let result;
          try {
            result = await this.#runCli({
              argv: input.argv,
              cwd: input.cwd,
              environment,
              executable: 'git',
              excludedExecutableDirectories: [
                ...(this.#dependencies.excludedExecutableDirectories ?? []),
              ],
              maxOutputBytes: 65_536,
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              timeoutMs: 120_000,
            });
          } catch {
            throw new AgentSystemToolError(
              'tool_unavailable',
              'The Git worktree executable is unavailable.',
            );
          }
          if (result.timedOut) {
            throw new AgentSystemToolError(
              'execution_timed_out',
              'The Git worktree request timed out.',
            );
          }
          return {
            exitCode: result.exitCode,
            stderr: redact(result.stderr, secrets),
            stdout: redact(result.stdout, secrets),
          };
        },
      },
    };
  }
}
