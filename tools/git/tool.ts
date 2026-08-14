import { isAbsolute, relative } from 'node:path';

import defineAgentSystemCliTool from '../../lib/define-agent-system-cli-tool.ts';
import AgentSystemToolError, { type AgentSystemToolErrorCode } from '../../lib/tool-error.ts';
import type { AgentSystemCliResult } from '../../lib/tool-types.ts';
import type { AgentManifest } from '../../utils/manifest-types.ts';
import resolveGitAllowedSignersFile from './allowed-signers-file.ts';
import type {
  GitSigningConfiguration,
  GitSshConfiguration,
  GitToolConfiguration,
} from './config-schema.ts';
import {
  gitIdentityConfiguration,
  gitIdentityEnvironment,
  type GitConfigurationEntry,
  resolveGitIdentity,
} from './identity.ts';
import {
  classifyGitOperation,
  gitCommandPosition,
  isRawGitWorktreeMutation,
} from './operation-classifier.ts';
import { authorizeGitOperation } from './policy.ts';
import gitCommandHasSigningControl from './signing-control.ts';
import type GitSshResourceService from './ssh-resource-service.ts';
import { gitToolSchema, type GitToolInput } from './tool-schema.ts';
import resolveGitWorktreeLayout from './worktree-layout.ts';

interface ResolvedGitConfiguration {
  externalExtensions: string[];
  identity: ReturnType<typeof resolveGitIdentity>;
  signing?: GitSigningConfiguration;
  ssh?: GitSshConfiguration;
  worktrees?: NonNullable<GitToolConfiguration['git']['worktrees']>;
}

export interface GitToolDependencies {
  extensionAvailable?(name: string): Promise<boolean> | boolean;
  sshResourceService?: Pick<GitSshResourceService, 'acquire'>;
}

export interface GitCommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  truncated: boolean;
}

function toolError(code: AgentSystemToolErrorCode, message: string): never {
  throw new AgentSystemToolError(code, message);
}

function isConfigRead(argv: readonly string[]): boolean {
  const position = gitCommandPosition(argv);
  const argumentsAfterCommand = position < 0 ? [] : argv.slice(position + 1);
  if (argumentsAfterCommand.some((value) => value === '--')) return false;
  if (
    argumentsAfterCommand.some((value) =>
      [
        '--add',
        '--edit',
        '--file',
        '--global',
        '--local',
        '--remove-section',
        '--rename-section',
        '--replace-all',
        '--system',
        '--unset',
        '--unset-all',
        '--worktree',
        '-e',
        '-f',
      ].some((flag) => value === flag || value.startsWith(`${flag}=`)),
    )
  ) {
    return false;
  }
  const values = argumentsAfterCommand.filter((value) => !value.startsWith('-'));
  return values.length <= 1;
}

function signingConfiguration(
  signing: GitSigningConfiguration | undefined,
  workspaceDir: string,
): GitConfigurationEntry[] {
  if (!signing) return [];
  const configuration: GitConfigurationEntry[] = [
    ['gpg.format', 'ssh'],
    ['commit.gpgSign', 'true'],
    ['tag.gpgSign', 'true'],
  ];
  if (signing.allowedSignersFile) {
    try {
      configuration.push(
        [
          'gpg.ssh.allowedSignersFile',
          resolveGitAllowedSignersFile(signing.allowedSignersFile, workspaceDir),
        ],
        ['gpg.minTrustLevel', 'fully'],
      );
    } catch {
      throw new AgentSystemToolError(
        'configuration_unavailable',
        'The configured Git SSH allowed signers file is unavailable or unsafe.',
      );
    }
  }
  return configuration;
}

function validateInput(input: GitToolInput): void {
  if (
    input.argv.length === 0 ||
    input.argv.some((argument) => argument.includes('\0')) ||
    (input.stdin !== undefined && Buffer.byteLength(input.stdin) > 65_536)
  ) {
    toolError('invalid_arguments', 'The Git request is invalid.');
  }
  if (
    input.cwd !== undefined &&
    (input.cwd.includes('\0') ||
      (!isAbsolute(input.cwd) && relative('.', input.cwd).split(/[\\/]/u).includes('..')))
  ) {
    toolError(
      'invalid_arguments',
      'The Git working directory must stay inside the agent workspace or configured worktree root.',
    );
  }

  const blockedOptions = ['--config-env', '--exec-path', '--git-dir', '--work-tree', '-C', '-c'];
  if (
    input.argv.some((argument) =>
      blockedOptions.some(
        (option) =>
          argument === option ||
          argument.startsWith(`${option}=`) ||
          (option.length === 2 && argument.startsWith(option) && argument.length > 2),
      ),
    )
  ) {
    toolError(
      'invalid_arguments',
      'Agent System Git commands may not override executable, configuration, or working-directory boundaries.',
    );
  }

  const position = gitCommandPosition(input.argv);
  const command = position < 0 ? undefined : input.argv[position]?.toLowerCase();
  if (!command && !input.argv.some((value) => value === '--help' || value === '--version')) {
    toolError('invalid_arguments', 'The Git command is missing.');
  }
  if (isRawGitWorktreeMutation(input.argv)) {
    toolError(
      'invalid_arguments',
      'Raw Git worktree mutation is unavailable; use agent_system_git_worktree for managed lifecycle changes.',
    );
  }
  if (command?.startsWith('credential')) {
    toolError('invalid_arguments', 'Agent System Git commands may not manage credentials.');
  }
  if (gitCommandHasSigningControl(input)) {
    toolError(
      'invalid_arguments',
      'Agent System Git signing configuration may not be overridden by command arguments.',
    );
  }
  if (command === 'config' && !isConfigRead(input.argv)) {
    toolError(
      'invalid_arguments',
      'Agent System Git configuration is projected from agent.yaml and may not be mutated by git.',
    );
  }
  if (command === 'remote') {
    const subcommand = input.argv[position + 1]?.toLowerCase();
    if (subcommand && !['get-url', 'show', '-v', '--verbose'].includes(subcommand)) {
      toolError(
        'invalid_arguments',
        'Agent System Git commands may inspect but may not mutate repository remotes.',
      );
    }
  }
}

function normalizeCommand(result: AgentSystemCliResult): GitCommandResult {
  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
    truncated: result.truncated,
  };
}

function readConfiguration(manifest: AgentManifest): GitToolConfiguration | undefined {
  if (manifest.git === undefined) return undefined;
  return {
    agent: {
      ...(manifest.agent.email === undefined ? {} : { email: manifest.agent.email }),
      ...(manifest.agent.name === undefined ? {} : { name: manifest.agent.name }),
    },
    git: manifest.git,
  };
}

/** Define the fixed-executable Git tool over one agent-scoped identity. */
export function createGitTool(dependencies: GitToolDependencies = {}) {
  return defineAgentSystemCliTool({
    apiVersion: 1,
    id: 'git',
    authorization: {
      authorize(operation, configuration) {
        return authorizeGitOperation(operation, configuration, {
          extensionAvailable: dependencies.extensionAvailable,
        });
      },
      policyId: 'agent-system.git',
    },
    configuration: {
      read: readConfiguration,
      resolve(configuration, resolver): ResolvedGitConfiguration {
        return {
          externalExtensions: Object.keys(configuration.git.extensions ?? {}).sort(),
          identity: resolveGitIdentity(configuration, resolver),
          ...(configuration.git.signing === undefined
            ? {}
            : { signing: configuration.git.signing }),
          ...(configuration.git.ssh === undefined ? {} : { ssh: configuration.git.ssh }),
          ...(configuration.git.worktrees === undefined
            ? {}
            : { worktrees: configuration.git.worktrees }),
        };
      },
    },
    guidance: {
      prompt:
        'For Git work, use the $agent-system-git-cli skill and prefer agent_system_git over exec or direct git commands. Pass ordinary non-interactive git arguments in argv; Agent System supplies the active agent identity and contained working directory.',
    },
    runner: {
      acquireResources(_input, configuration, scope) {
        const authentication = configuration.ssh;
        const signing = configuration.signing;
        if (!authentication && !signing) return undefined;
        if (!dependencies.sshResourceService) {
          throw new AgentSystemToolError(
            'credential_unavailable',
            'Git SSH authentication or signing is unavailable in this runtime.',
          );
        }
        const staticSigningConfiguration = signingConfiguration(
          configuration.signing,
          scope.workspaceDir,
        );
        const gitConfigurationOffset =
          gitIdentityConfiguration(
            configuration.identity,
            process.platform,
            configuration.externalExtensions,
          ).length + staticSigningConfiguration.length;
        return dependencies.sshResourceService.acquire(
          {
            ...(authentication === undefined ? {} : { authentication }),
            ...(signing === undefined
              ? {}
              : { signing: { key: signing.key, gitConfigurationOffset } }),
          },
          {
            resolveEnvironment: scope.resolveEnvironment,
            ...(scope.signal === undefined ? {} : { signal: scope.signal }),
            workspaceDir: scope.workspaceDir,
          },
        );
      },
      argv(input) {
        return [...input.argv];
      },
      environment(configuration, scope) {
        return {
          ...gitIdentityEnvironment(
            configuration.identity,
            process.platform,
            configuration.externalExtensions,
            signingConfiguration(configuration.signing, scope.workspaceDir),
          ),
        };
      },
      executable: 'git',
      maxOutputBytes: 65_536,
      stdin(input) {
        return input.stdin;
      },
      timeoutMs: 30_000,
      admittedWorkingDirectories(_input, configuration, scope) {
        if (!configuration.worktrees) return [];
        const layout = resolveGitWorktreeLayout(scope.workspaceDir, configuration.worktrees);
        return scope.source === 'tool'
          ? [layout.worktreeRoot]
          : [layout.worktreeRoot, ...Object.values(layout.localRepositories)];
      },
      workingDirectory(input, _configuration, scope) {
        return scope.source === 'tool' ? (input.cwd ?? '.') : scope.commandWorkingDirectory;
      },
    },
    commands: [{ command: 'git' }],
    tool: {
      classify: classifyGitOperation,
      description:
        'Run Git with the active Agent System agent identity, managed SSH signing, and a contained working directory. Supply ordinary non-interactive git arguments in argv, optional bounded stdin, and an optional cwd inside the agent workspace or configured worktree root. Configuration mutation, signing overrides, credential commands, hooks, and working-directory escape options are unavailable.',
      inputFromCommand(argv): GitToolInput {
        return { argv: [...argv] };
      },
      label: 'Agent System Git',
      name: 'agent_system_git',
      normalize: normalizeCommand,
      parameters: gitToolSchema,
      validate: validateInput,
    },
  });
}
