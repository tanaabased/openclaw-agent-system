import AgentSystemToolError from '../../lib/tool-error.ts';
import type {
  AgentSystemOperation,
  AgentSystemSemanticToolDefinition,
  AgentSystemToolScope,
} from '../../lib/tool-types.ts';
import type { AgentManifest } from '../../utils/manifest-types.ts';
import { Value } from 'typebox/value';

import { authorizeGitOperation } from './policy.ts';
import type {
  GitSshConfiguration,
  GitToolConfiguration,
  GitWorktreeConfiguration,
} from './config-schema.ts';
import { resolveGitIdentity, type ResolvedGitIdentity } from './identity.ts';
import type GitWorktreeGitRunnerFactory from './worktree-git-runner.ts';
import normalizeGitWorktreeRemote from './worktree-remote.ts';
import type GitWorktreeService from './worktree-service.ts';
import type {
  GitWorktreePrepareInput,
  GitWorktreeResult,
  GitWorktreeServiceContext,
} from './worktree-service.ts';
import { gitWorktreeToolSchema, type GitWorktreeToolInput } from './worktree-tool-schema.ts';

export interface ResolvedGitWorktreeToolConfiguration {
  externalExtensions: string[];
  identity: ResolvedGitIdentity;
  ssh?: GitSshConfiguration;
  worktrees: GitWorktreeConfiguration;
}

export interface GitWorktreeToolDependencies {
  runnerFactory: Pick<GitWorktreeGitRunnerFactory, 'acquire'>;
  service: Pick<GitWorktreeService, 'list' | 'prepare' | 'remove'>;
}

interface GitWorktreeExecutionScope {
  agentId: string;
  resolveEnvironment(name: string): string | undefined;
  signal?: AbortSignal;
  source: AgentSystemToolScope['source'];
  workspaceDir: string;
}

export type GitWorktreeToolDefinition = AgentSystemSemanticToolDefinition<
  typeof gitWorktreeToolSchema,
  GitToolConfiguration,
  ResolvedGitWorktreeToolConfiguration,
  GitWorktreeResult | GitWorktreeResult[]
> & {
  prepareTrusted(
    input: GitWorktreePrepareInput,
    configuration: ResolvedGitWorktreeToolConfiguration,
    scope: GitWorktreeExecutionScope,
  ): Promise<GitWorktreeResult>;
};

function readConfiguration(manifest: AgentManifest): GitToolConfiguration | undefined {
  if (!manifest.git?.worktrees) return undefined;
  return {
    agent: {
      ...(manifest.agent.email === undefined ? {} : { email: manifest.agent.email }),
      ...(manifest.agent.name === undefined ? {} : { name: manifest.agent.name }),
    },
    git: manifest.git,
  };
}

function classify(input: GitWorktreeToolInput): AgentSystemOperation {
  if (input.action === 'list') {
    return {
      action: 'git.worktree.list',
      risk: 'read',
      ...(input.repositoryId === undefined
        ? {}
        : { resources: [{ type: 'git-repository', id: input.repositoryId }] }),
      summary: 'List Git worktrees',
    };
  }
  if (input.action === 'remove') {
    return {
      action: 'git.worktree.remove',
      risk: 'write',
      resources: [
        { type: 'git-repository', id: input.repositoryId },
        { type: 'git-worktree', id: input.workId },
      ],
      summary: 'Remove a Git worktree',
    };
  }
  return {
    action: `git.worktree.${input.action}`,
    risk: 'write',
    resources: [
      { type: 'git-repository', id: input.repository.id },
      { type: 'git-worktree', id: input.workId },
    ],
    summary: 'Prepare a Git worktree',
  };
}

function parseCommand(argv: string[]): GitWorktreeToolInput {
  const [action, ...arguments_] = argv;
  if (action === 'list') {
    if (arguments_.length > 1) throw new Error('Usage: worktree list [repository-id].');
    return {
      action,
      ...(arguments_[0] === undefined ? {} : { repositoryId: arguments_[0] }),
    };
  }
  if (action === 'remove') {
    if (arguments_.length !== 2) {
      throw new Error('Usage: worktree remove <repository-id> <work-id>.');
    }
    return { action, repositoryId: arguments_[0] ?? '', workId: arguments_[1] ?? '' };
  }
  if (action !== 'prepare') {
    throw new Error('Usage: worktree <prepare|list|remove>.');
  }

  const positional: string[] = [];
  let cloneUrl: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index] ?? '';
    if (value === '--clone-url') {
      const optionValue = arguments_[index + 1];
      if (!optionValue) throw new Error(`The ${value} option requires a value.`);
      cloneUrl = optionValue;
      index += 1;
    } else if (value.startsWith('-')) {
      throw new Error(`Unknown worktree option: ${value}.`);
    } else {
      positional.push(value);
    }
  }
  if (positional.length !== 3) {
    throw new Error(
      'Usage: worktree prepare <repository-id> <work-id> <base-ref> [--clone-url <url>].',
    );
  }
  return {
    action,
    baseRef: positional[2] ?? '',
    repository: {
      id: positional[0] ?? '',
      ...(cloneUrl === undefined ? {} : { cloneUrl }),
    },
    workId: positional[1] ?? '',
  };
}

function normalizeToolError(error: unknown): AgentSystemToolError {
  if (error instanceof AgentSystemToolError) return error;
  return new AgentSystemToolError(
    'execution_failed',
    error instanceof Error ? error.message : 'The Git worktree request failed.',
  );
}

/** Define the semantic Git worktree operation contract shared by native and CLI surfaces. */
export function createGitWorktreeToolDefinition(
  dependencies: GitWorktreeToolDependencies,
): GitWorktreeToolDefinition {
  const executeWithLease = async <T extends GitWorktreeResult | GitWorktreeResult[]>(
    authentication: boolean,
    configuration: ResolvedGitWorktreeToolConfiguration,
    scope: GitWorktreeExecutionScope,
    operation: (context: GitWorktreeServiceContext) => Promise<T>,
  ): Promise<T> => {
    const lease = await dependencies.runnerFactory.acquire(
      configuration,
      {
        resolveEnvironment: scope.resolveEnvironment,
        ...(scope.signal === undefined ? {} : { signal: scope.signal }),
        workspaceDir: scope.workspaceDir,
      },
      { authentication },
    );
    const context = {
      configuration: configuration.worktrees,
      git: lease.git,
      ...(scope.signal === undefined ? {} : { signal: scope.signal }),
      workspaceDir: scope.workspaceDir,
    };
    let operationError: AgentSystemToolError | undefined;
    let result: T | undefined;
    try {
      result = await operation(context);
    } catch (error) {
      operationError = normalizeToolError(error);
    }
    try {
      await lease.dispose();
    } catch {
      throw new AgentSystemToolError(
        'resource_cleanup_failed',
        'The Git worktree tool could not clean up invocation resources.',
      );
    }
    if (operationError) throw operationError;
    if (result === undefined) {
      throw new AgentSystemToolError(
        'execution_failed',
        'The Git worktree request returned no result.',
      );
    }
    return result;
  };

  return {
    apiVersion: 1,
    id: 'git-worktree',
    authorization: {
      authorize: authorizeGitOperation,
      policyId: 'agent-system.git-worktree',
    },
    configuration: {
      read: readConfiguration,
      resolve(configuration, resolver) {
        return {
          externalExtensions: Object.keys(configuration.git.extensions ?? {}).sort(),
          identity: resolveGitIdentity(configuration, resolver),
          ...(configuration.git.ssh === undefined ? {} : { ssh: configuration.git.ssh }),
          worktrees: configuration.git.worktrees ?? {},
        };
      },
    },
    async execute(input, configuration, scope) {
      return executeWithLease(input.action === 'prepare', configuration, scope, async (context) => {
        if (input.action === 'prepare') {
          return dependencies.service.prepare(context, {
            baseRef: input.baseRef,
            ...(input.repository.cloneUrl === undefined
              ? {}
              : { cloneUrl: input.repository.cloneUrl }),
            repositoryId: input.repository.id,
            workId: input.workId,
          });
        }
        if (input.action === 'list') {
          return dependencies.service.list(context, input.repositoryId);
        }
        return dependencies.service.remove(context, input.repositoryId, input.workId);
      });
    },
    async prepareTrusted(input, configuration, scope) {
      return executeWithLease(true, configuration, scope, (context) =>
        dependencies.service.prepare(context, input),
      );
    },
    guidance: {
      prompt:
        'For managed worktrees, use the $agent-system-git-worktree skill and agent_system_git_worktree to prepare, list, or remove them. Pass the returned path as cwd to agent_system_git for ordinary Git work.',
    },
    commands: [{ command: 'worktree' }],
    tool: {
      classify,
      description:
        'Prepare, list, and remove deterministic agent-scoped Git worktrees. Preparation may clone a missing managed repository from a network remote and never pushes.',
      inputFromCommand: parseCommand,
      label: 'Agent System Git Worktree',
      name: 'agent_system_git_worktree',
      parameters: gitWorktreeToolSchema,
      validate(input) {
        if (!Value.Check(gitWorktreeToolSchema, input)) {
          throw new Error('The Git worktree request is invalid.');
        }
        if (input.action === 'prepare' && input.repository.cloneUrl !== undefined) {
          normalizeGitWorktreeRemote(input.repository.cloneUrl);
        }
      },
    },
  };
}
