import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveToolExecutable } from '../../lib/tool-cli-runner.ts';
import AgentSystemToolError from '../../lib/tool-error.ts';
import type { AgentSystemToolResourceLease } from '../../lib/tool-types.ts';
import runCredentialCommand, {
  type CredentialCommandOptions,
  type CredentialCommandResult,
} from '../../utils/run-credential-command.ts';
import type { GitSigningConfiguration, GitSshConfiguration } from './config-schema.ts';
import loadGitSshAgent, {
  type GitSshAgentProcess,
  type StartGitSshAgentOptions,
} from './ssh-agent-process.ts';
import { loadGitPrivateKeySources, type GitPrivateKeySourceContext } from './private-key-source.ts';

const helperEnvironmentNames = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TEMP', 'TMP', 'TMPDIR'] as const;

export interface GitSshResourceScope {
  resolveEnvironment(name: string): string | undefined;
  signal?: AbortSignal;
  workspaceDir: string;
}

export interface GitSshResourceRequest {
  authentication?: GitSshConfiguration;
  signing?: Pick<GitSigningConfiguration, 'key'> & { gitConfigurationOffset: number };
}

export interface GitSshDependencyRequirements {
  authentication?: boolean;
  signing?: boolean;
}

export interface GitSshResourceServiceDependencies {
  authenticationLauncherPath: string;
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  createTemporaryDirectory?(): Promise<string>;
  currentUid?: number;
  excludedExecutableDirectories?: readonly string[];
  homeDirectory?: string;
  loadPrivateKeys?(
    sources: GitSshConfiguration['privateKeys'],
    context: GitPrivateKeySourceContext,
  ): Promise<string[]>;
  removeTemporaryDirectory?(path: string): Promise<void>;
  resolveExecutable?(name: string): Promise<string>;
  runCommand?(options: CredentialCommandOptions): Promise<CredentialCommandResult>;
  secureTemporaryDirectory?(path: string): Promise<void>;
  signingKeyLauncherPath: string;
  signingProgramPath: string;
  startAgent?(options: StartGitSshAgentOptions): Promise<GitSshAgentProcess>;
  writePrivateFile?(path: string, contents: string): Promise<void>;
}

function quoteSshConfigValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function helperEnvironment(baseEnvironment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of helperEnvironmentNames) {
    const value = baseEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.SSH_ASKPASS_REQUIRE = 'never';
  return environment;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function publicKeys(result: CredentialCommandResult): string[] {
  if (result.status !== 'completed' || result.exitCode !== 0) {
    throw new Error('ssh-add could not list public keys');
  }
  const keys = result.stdout
    .toString('utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    keys.length === 0 ||
    keys.some((line) => {
      const [type, material] = line.split(/\s+/u);
      return (
        !type ||
        !material ||
        !/^(?:ecdsa-|sk-|ssh-)/u.test(type) ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(material) ||
        line.length > 16_384
      );
    })
  ) {
    throw new Error('ssh-add returned invalid public keys');
  }
  return keys;
}

/** Own invocation-scoped OpenSSH resources for Git without exposing private keys to Git. */
export default class GitSshResourceService {
  readonly #dependencies: GitSshResourceServiceDependencies;
  readonly #loadPrivateKeys: NonNullable<GitSshResourceServiceDependencies['loadPrivateKeys']>;
  readonly #removeTemporaryDirectory: NonNullable<
    GitSshResourceServiceDependencies['removeTemporaryDirectory']
  >;
  readonly #resolveExecutable: NonNullable<GitSshResourceServiceDependencies['resolveExecutable']>;
  readonly #runCommand: NonNullable<GitSshResourceServiceDependencies['runCommand']>;
  readonly #secureTemporaryDirectory: NonNullable<
    GitSshResourceServiceDependencies['secureTemporaryDirectory']
  >;
  readonly #startAgent: NonNullable<GitSshResourceServiceDependencies['startAgent']>;
  readonly #writePrivateFile: NonNullable<GitSshResourceServiceDependencies['writePrivateFile']>;

  constructor(dependencies: GitSshResourceServiceDependencies) {
    this.#dependencies = dependencies;
    this.#loadPrivateKeys = dependencies.loadPrivateKeys ?? loadGitPrivateKeySources;
    this.#removeTemporaryDirectory =
      dependencies.removeTemporaryDirectory ??
      ((path) => rm(path, { force: true, recursive: true }));
    this.#resolveExecutable =
      dependencies.resolveExecutable ??
      ((name) =>
        resolveToolExecutable(
          name,
          dependencies.baseEnvironment.PATH ?? '',
          dependencies.excludedExecutableDirectories,
        ));
    this.#runCommand = dependencies.runCommand ?? runCredentialCommand;
    this.#secureTemporaryDirectory =
      dependencies.secureTemporaryDirectory ?? ((path) => chmod(path, 0o700));
    this.#startAgent = dependencies.startAgent ?? loadGitSshAgent;
    this.#writePrivateFile =
      dependencies.writePrivateFile ??
      ((path, contents) => writeFile(path, contents, { encoding: 'utf8', mode: 0o600 }));
  }

  /** Report missing installed-host OpenSSH dependencies without mutating the host. */
  async inspectDependencies(
    requirements: GitSshDependencyRequirements = { authentication: true },
  ): Promise<{ missing: string[] }> {
    const missing: string[] = [];
    const names = new Set(['ssh-agent', 'ssh-add']);
    if (requirements.authentication) names.add('ssh');
    if (requirements.signing) names.add('ssh-keygen');
    for (const name of names) {
      try {
        await this.#resolveExecutable(name);
      } catch {
        missing.push(name);
      }
    }
    return { missing };
  }

  /** Route every SSH transport through the invocation-scoped authentication helper. */
  authenticationLauncherEnvironment(): Record<string, string> {
    return {
      GIT_SSH: this.#dependencies.authenticationLauncherPath,
      GIT_SSH_VARIANT: 'ssh',
    };
  }

  /** Start, populate, and project isolated authentication and signing agents for one invocation. */
  async acquire(
    request: GitSshResourceRequest,
    scope: GitSshResourceScope,
  ): Promise<AgentSystemToolResourceLease> {
    let authenticationAgent: GitSshAgentProcess | undefined;
    let signingAgent: GitSshAgentProcess | undefined;
    let directory: string | undefined;
    const cleanup = async () => {
      let failure: unknown;
      try {
        await signingAgent?.dispose();
      } catch (error) {
        failure = error;
      }
      try {
        await authenticationAgent?.dispose();
      } catch (error) {
        failure ??= error;
      }
      try {
        if (directory) await this.#removeTemporaryDirectory(directory);
      } catch (error) {
        failure ??= error;
      }
      authenticationAgent = undefined;
      signingAgent = undefined;
      directory = undefined;
      if (failure) throw failure;
    };

    try {
      if (!request.authentication && !request.signing) {
        throw new Error('no SSH resources requested');
      }
      const ssh = request.authentication ? await this.#resolveExecutable('ssh') : undefined;
      const sshAgent = await this.#resolveExecutable('ssh-agent');
      const sshAdd = await this.#resolveExecutable('ssh-add');
      const sshKeygen = request.signing ? await this.#resolveExecutable('ssh-keygen') : undefined;
      const sourceContext = {
        ...(this.#dependencies.currentUid === undefined
          ? {}
          : { currentUid: this.#dependencies.currentUid }),
        ...(this.#dependencies.homeDirectory === undefined
          ? {}
          : { homeDirectory: this.#dependencies.homeDirectory }),
        resolveEnvironment: scope.resolveEnvironment,
        workspaceDir: scope.workspaceDir,
      };
      const authenticationKeys = request.authentication
        ? await this.#loadPrivateKeys(request.authentication.privateKeys, sourceContext)
        : [];
      const signingKeys = request.signing
        ? await this.#loadPrivateKeys([{ fromEnvironment: request.signing.key }], sourceContext)
        : [];
      if (request.signing && signingKeys.length !== 1) {
        throw new Error('signing source returned an unexpected key count');
      }
      const resourceDirectory = this.#dependencies.createTemporaryDirectory
        ? await this.#dependencies.createTemporaryDirectory()
        : await mkdtemp(join(tmpdir(), 'as-ssh-'));
      directory = resourceDirectory;
      await this.#secureTemporaryDirectory(resourceDirectory);
      const environment = helperEnvironment(this.#dependencies.baseEnvironment);
      const addPrivateKeys = async (
        privateKeys: readonly string[],
        targetEnvironment: NodeJS.ProcessEnv,
      ) => {
        for (const privateKey of privateKeys) {
          const result = await this.#runCommand({
            args: ['-'],
            command: sshAdd,
            environment: targetEnvironment,
            input: privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`,
            maximumOutputBytes: 16_384,
            timeoutMs: 10_000,
          });
          if (result.status !== 'completed' || result.exitCode !== 0) {
            throw new AgentSystemToolError(
              'credential_unavailable',
              'A configured Git SSH private key could not be loaded noninteractively.',
            );
          }
        }
      };
      const listPublicKeys = (targetEnvironment: NodeJS.ProcessEnv) =>
        this.#runCommand({
          args: ['-L'],
          command: sshAdd,
          environment: targetEnvironment,
          maximumOutputBytes: 65_536,
          timeoutMs: 10_000,
        }).then(publicKeys);

      let authenticationSocketPath: string | undefined;
      let authenticationPublicKeys: string[] = [];
      if (request.authentication) {
        const requestedSocketPath = join(resourceDirectory, 'a');
        authenticationAgent = await this.#startAgent({
          environment,
          executable: sshAgent,
          ...(scope.signal === undefined ? {} : { signal: scope.signal }),
          socketPath: requestedSocketPath,
        });
        authenticationSocketPath = authenticationAgent.socketPath;
        const authenticationEnvironment = {
          ...environment,
          SSH_AUTH_SOCK: authenticationSocketPath,
        };
        await addPrivateKeys(authenticationKeys, authenticationEnvironment);
        authenticationPublicKeys = await listPublicKeys(authenticationEnvironment);
      }

      let signingSocketPath: string | undefined;
      if (request.signing) {
        const requestedSocketPath = join(resourceDirectory, 's');
        signingAgent = await this.#startAgent({
          environment,
          executable: sshAgent,
          ...(scope.signal === undefined ? {} : { signal: scope.signal }),
          socketPath: requestedSocketPath,
        });
        signingSocketPath = signingAgent.socketPath;
        const signingEnvironment = { ...environment, SSH_AUTH_SOCK: signingSocketPath };
        await addPrivateKeys(signingKeys, signingEnvironment);
        const keys = await listPublicKeys(signingEnvironment);
        if (keys.length !== 1) throw new Error('signing agent returned an unexpected key count');
      }
      const identityPaths: string[] = [];
      for (const [index, publicKey] of authenticationPublicKeys.entries()) {
        const path = join(resourceDirectory, `k${index}.pub`);
        await this.#writePrivateFile(path, `${publicKey}\n`);
        identityPaths.push(path);
      }
      const configPath = authenticationSocketPath ? join(resourceDirectory, 'c') : undefined;
      if (configPath && authenticationSocketPath) {
        await this.#writePrivateFile(
          configPath,
          [
            'Host *',
            '  BatchMode yes',
            '  ForwardAgent no',
            '  IdentitiesOnly yes',
            `  IdentityAgent ${quoteSshConfigValue(authenticationSocketPath)}`,
            ...identityPaths.map((path) => `  IdentityFile ${quoteSshConfigValue(path)}`),
            '  KbdInteractiveAuthentication no',
            '  PasswordAuthentication no',
            '  PreferredAuthentications publickey',
            '',
          ].join('\n'),
        );
      }

      const leaseEnvironment: Record<string, string> = {
        SSH_ASKPASS_REQUIRE: 'never',
      };
      if (request.authentication && configPath && ssh) {
        Object.assign(leaseEnvironment, {
          AGENT_SYSTEM_SSH_CONFIG: configPath,
          AGENT_SYSTEM_SSH_EXECUTABLE: ssh,
          ...this.authenticationLauncherEnvironment(),
        });
      }
      if (request.signing && signingSocketPath && sshKeygen) {
        const index = request.signing.gitConfigurationOffset;
        Object.assign(leaseEnvironment, {
          AGENT_SYSTEM_SSH_ADD_EXECUTABLE: sshAdd,
          AGENT_SYSTEM_SSH_KEYGEN_EXECUTABLE: sshKeygen,
          AGENT_SYSTEM_SSH_SIGNING_SOCKET: signingSocketPath,
          GIT_CONFIG_COUNT: String(index + 2),
          [`GIT_CONFIG_KEY_${index}`]: 'gpg.ssh.defaultKeyCommand',
          [`GIT_CONFIG_VALUE_${index}`]: shellQuote(this.#dependencies.signingKeyLauncherPath),
          [`GIT_CONFIG_KEY_${index + 1}`]: 'gpg.ssh.program',
          [`GIT_CONFIG_VALUE_${index + 1}`]: shellQuote(this.#dependencies.signingProgramPath),
        });
      }

      let disposed = false;
      return {
        async dispose() {
          if (disposed) return;
          disposed = true;
          await cleanup();
        },
        environment: leaseEnvironment,
        sensitiveValues: [...authenticationKeys, ...signingKeys],
      };
    } catch (error) {
      try {
        await cleanup();
      } catch {
        throw new AgentSystemToolError(
          'resource_cleanup_failed',
          'The Git tool could not clean up SSH resources after preparation failed.',
        );
      }
      if (error instanceof AgentSystemToolError) throw error;
      throw new AgentSystemToolError(
        'credential_unavailable',
        'Git SSH authentication or signing resources could not be prepared.',
      );
    }
  }
}
