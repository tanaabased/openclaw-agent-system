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
import type { GitSshConfiguration } from './config-schema.ts';
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

export interface GitSshResourceServiceDependencies {
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  createTemporaryDirectory?(): Promise<string>;
  currentUid?: number;
  excludedExecutableDirectories?: readonly string[];
  homeDirectory?: string;
  launcherPath: string;
  loadPrivateKeys?(
    sources: GitSshConfiguration['privateKeys'],
    context: GitPrivateKeySourceContext,
  ): Promise<string[]>;
  removeTemporaryDirectory?(path: string): Promise<void>;
  resolveExecutable?(name: string): Promise<string>;
  runCommand?(options: CredentialCommandOptions): Promise<CredentialCommandResult>;
  secureTemporaryDirectory?(path: string): Promise<void>;
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
  async inspectDependencies(): Promise<{ missing: string[] }> {
    const missing: string[] = [];
    for (const name of ['ssh', 'ssh-agent', 'ssh-add']) {
      try {
        await this.#resolveExecutable(name);
      } catch {
        missing.push(name);
      }
    }
    return { missing };
  }

  /** Fail closed for SSH transport syntax that is not selected for resource acquisition. */
  launcherEnvironment(): Record<string, string> {
    return {
      GIT_SSH: this.#dependencies.launcherPath,
      GIT_SSH_VARIANT: 'ssh',
    };
  }

  /** Start, populate, and project one isolated ssh-agent for a single Git invocation. */
  async acquire(
    configuration: GitSshConfiguration,
    scope: GitSshResourceScope,
  ): Promise<AgentSystemToolResourceLease> {
    let agent: GitSshAgentProcess | undefined;
    let directory: string | undefined;
    const cleanup = async () => {
      let failure: unknown;
      try {
        await agent?.dispose();
      } catch (error) {
        failure = error;
      }
      try {
        if (directory) await this.#removeTemporaryDirectory(directory);
      } catch (error) {
        failure ??= error;
      }
      agent = undefined;
      directory = undefined;
      if (failure) throw failure;
    };

    try {
      const ssh = await this.#resolveExecutable('ssh');
      const sshAgent = await this.#resolveExecutable('ssh-agent');
      const sshAdd = await this.#resolveExecutable('ssh-add');
      const privateKeys = await this.#loadPrivateKeys(configuration.privateKeys, {
        ...(this.#dependencies.currentUid === undefined
          ? {}
          : { currentUid: this.#dependencies.currentUid }),
        ...(this.#dependencies.homeDirectory === undefined
          ? {}
          : { homeDirectory: this.#dependencies.homeDirectory }),
        resolveEnvironment: scope.resolveEnvironment,
        workspaceDir: scope.workspaceDir,
      });
      const resourceDirectory = this.#dependencies.createTemporaryDirectory
        ? await this.#dependencies.createTemporaryDirectory()
        : await mkdtemp(join(tmpdir(), 'as-ssh-'));
      directory = resourceDirectory;
      await this.#secureTemporaryDirectory(resourceDirectory);
      const socketPath = join(resourceDirectory, 'a');
      const environment = helperEnvironment(this.#dependencies.baseEnvironment);
      agent = await this.#startAgent({
        environment,
        executable: sshAgent,
        ...(scope.signal === undefined ? {} : { signal: scope.signal }),
        socketPath,
      });
      const agentEnvironment = { ...environment, SSH_AUTH_SOCK: socketPath };
      for (const privateKey of privateKeys) {
        const result = await this.#runCommand({
          args: ['-'],
          command: sshAdd,
          environment: agentEnvironment,
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
      const listedKeys = publicKeys(
        await this.#runCommand({
          args: ['-L'],
          command: sshAdd,
          environment: agentEnvironment,
          maximumOutputBytes: 65_536,
          timeoutMs: 10_000,
        }),
      );
      const identityPaths: string[] = [];
      for (const [index, publicKey] of listedKeys.entries()) {
        const path = join(resourceDirectory, `k${index}.pub`);
        await this.#writePrivateFile(path, `${publicKey}\n`);
        identityPaths.push(path);
      }
      const configPath = join(resourceDirectory, 'c');
      await this.#writePrivateFile(
        configPath,
        [
          'Host *',
          '  BatchMode yes',
          '  ForwardAgent no',
          '  IdentitiesOnly yes',
          `  IdentityAgent ${quoteSshConfigValue(socketPath)}`,
          ...identityPaths.map((path) => `  IdentityFile ${quoteSshConfigValue(path)}`),
          '  KbdInteractiveAuthentication no',
          '  PasswordAuthentication no',
          '  PreferredAuthentications publickey',
          '',
        ].join('\n'),
      );

      let disposed = false;
      return {
        async dispose() {
          if (disposed) return;
          disposed = true;
          await cleanup();
        },
        environment: {
          AGENT_SYSTEM_SSH_CONFIG: configPath,
          AGENT_SYSTEM_SSH_EXECUTABLE: ssh,
          ...this.launcherEnvironment(),
          SSH_ASKPASS_REQUIRE: 'never',
          SSH_AUTH_SOCK: socketPath,
        },
        sensitiveValues: privateKeys,
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
        'Git SSH authentication resources could not be prepared.',
      );
    }
  }
}
