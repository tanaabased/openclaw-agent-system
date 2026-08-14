import defineAgentSystemCliTool from '../../lib/define-agent-system-cli-tool.ts';
import AgentSystemToolError, { type AgentSystemToolErrorCode } from '../../lib/tool-error.ts';
import type { AgentSystemCliResult } from '../../lib/tool-types.ts';
import type { GitHubManifestConfiguration } from '../../utils/github-section-schema.ts';
import type { AgentManifest } from '../../utils/manifest-types.ts';
import type GitHubConfigStore from './config-store.ts';
import { resolveGitHubCliConfiguration, type GitHubCliConfiguration } from './config-schema.ts';
import {
  authorizeGitHubOperation,
  classifyGitHubOperation,
  resolveGitHubCommand,
} from './policy.ts';
import { githubToolSchema, type GitHubToolInput } from './tool-schema.ts';

interface ResolvedGitHubConfiguration {
  cli: GitHubCliConfiguration;
  host: 'github.com';
  tokenBindings: readonly string[];
  username?: string;
}

export interface GitHubCommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  truncated: boolean;
}

export interface GitHubToolDependencies {
  configStore: Pick<GitHubConfigStore, 'configDirectory' | 'reconcile'>;
}

function toolError(code: AgentSystemToolErrorCode, message: string): never {
  throw new AgentSystemToolError(code, message);
}

function validateInput(input: GitHubToolInput): void {
  if (
    input.argv.length === 0 ||
    input.argv.some((argument) => argument.includes('\0')) ||
    (input.stdin !== undefined && Buffer.byteLength(input.stdin) > 65_536)
  ) {
    toolError('invalid_arguments', 'The GitHub CLI request is invalid.');
  }

  const blockedFlags = ['--browser', '--editor', '--host', '--hostname', '--show-token', '--web'];
  if (
    input.argv.some(
      (argument) =>
        argument === '-w' ||
        blockedFlags.some((flag) => argument === flag || argument.startsWith(`${flag}=`)),
    )
  ) {
    toolError(
      'invalid_arguments',
      'Agent System GitHub commands may not override identity or launch a browser or editor.',
    );
  }

  const { command, position } = resolveGitHubCommand(input.argv);
  const subcommand = position < 0 ? undefined : input.argv[position + 1];
  if (!command) toolError('invalid_arguments', 'The GitHub CLI command is missing.');
  if (command === 'alias' || command === 'extension') {
    toolError(
      'invalid_arguments',
      'Agent System GitHub commands may not manage aliases or extensions.',
    );
  }
  if (command === 'auth' && subcommand !== 'status') {
    toolError(
      'invalid_arguments',
      'Agent System GitHub commands may inspect auth status but may not reveal or mutate authentication.',
    );
  }
  if (command === 'config' && subcommand !== 'get' && subcommand !== 'list') {
    toolError(
      'invalid_arguments',
      'Agent System GitHub config is generated from agent.yaml and may not be mutated by gh.',
    );
  }
}

function normalizeCommand(result: AgentSystemCliResult): GitHubCommandResult {
  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
    truncated: result.truncated,
  };
}

function readConfiguration(manifest: AgentManifest): GitHubManifestConfiguration | undefined {
  return manifest.github;
}

/** Define the fixed-executable GitHub CLI tool over one agent-scoped configuration store. */
export function createGitHubTool(dependencies: GitHubToolDependencies) {
  return defineAgentSystemCliTool({
    apiVersion: 1,
    id: 'github',
    authorization: {
      authorize: authorizeGitHubOperation,
      policyId: 'agent-system.github',
    },
    configuration: {
      read: readConfiguration,
      resolve(configuration, resolver): ResolvedGitHubConfiguration {
        return {
          cli: resolveGitHubCliConfiguration(configuration),
          host: configuration.host ?? 'github.com',
          tokenBindings: configuration.token ? [configuration.token] : ['GH_TOKEN', 'GITHUB_TOKEN'],
          ...(configuration.username
            ? { username: resolver.resolve(configuration.username, '/github/username') }
            : {}),
        };
      },
    },
    guidance: {
      prompt:
        'For GitHub work, use the $agent-system-github-cli skill and prefer agent_system_github over exec, direct gh commands, HTTP, SDKs, or unrelated GitHub integrations. Pass ordinary non-interactive gh arguments in argv; Agent System supplies the active agent credential and isolated config.',
    },
    runner: {
      argv(input) {
        return [...input.argv];
      },
      credentialBindings(configuration) {
        return { GH_TOKEN: { anyOf: configuration.tokenBindings } };
      },
      environment(configuration, scope) {
        return {
          GH_CONFIG_DIR: dependencies.configStore.configDirectory(scope.agentId),
          ...(scope.source === 'command' && scope.terminalColumns
            ? { GH_FORCE_TTY: String(scope.terminalColumns) }
            : {}),
          GH_HOST: configuration.host,
          GH_PAGER: 'cat',
          GH_PROMPT_DISABLED: '1',
          PAGER: 'cat',
        };
      },
      executable: 'gh',
      maxOutputBytes: 65_536,
      preflight(configuration) {
        if (!configuration.username) return undefined;
        return {
          argv: ['api', 'user', '--jq', '.login'],
          validate(result) {
            if (result.exitCode !== 0) {
              toolError('execution_failed', 'GitHub rejected the authenticated user check.');
            }
            if (result.truncated) {
              toolError('execution_failed', 'GitHub returned an invalid authenticated user check.');
            }
            const actual = result.stdout.trim();
            if (actual.toLowerCase() !== configuration.username?.toLowerCase()) {
              toolError(
                'tool_identity_mismatch',
                `GitHub returned ${actual || 'an unknown user'}, not the configured username ${configuration.username}.`,
              );
            }
          },
        };
      },
      async prepare(configuration, scope) {
        await dependencies.configStore.reconcile(scope.agentId, configuration.cli);
      },
      stdin(input) {
        return input.stdin;
      },
      timeoutMs: 30_000,
      workingDirectory(_input, _configuration, scope) {
        return scope.source === 'agent-command' ? scope.commandWorkingDirectory : undefined;
      },
    },
    commands: [{ command: 'gh' }],
    tool: {
      classify(input) {
        return classifyGitHubOperation(input);
      },
      description:
        'Run the trusted GitHub CLI with the active Agent System agent credential and isolated configuration. Supply ordinary non-interactive gh arguments in argv and optional bounded stdin. Authentication mutation, credential display, config mutation, aliases, extensions, browsers, and editors are unavailable.',
      inputFromCommand(argv, stdin): GitHubToolInput {
        return { argv: [...argv], ...(stdin === undefined ? {} : { stdin }) };
      },
      label: 'Agent System GitHub CLI',
      name: 'agent_system_github',
      normalize: normalizeCommand,
      parameters: githubToolSchema,
      validate: validateInput,
    },
  });
}
