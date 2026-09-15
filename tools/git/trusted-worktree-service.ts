import { basename, dirname, resolve } from 'node:path';

import type AgentEnvironmentService from '../../environment/service.ts';
import type AgentManifestService from '../../manifest/service.ts';
import AgentSystemToolError from '../../api/error.ts';
import resolveManifestValue from '../../manifest/resolve-value.ts';
import type { GitWorktreeToolDefinition } from './worktree-tool.ts';
import type { GitWorktreeToolInput } from './worktree-tool-schema.ts';
import {
  gitHubIssueBranchSuffix,
  gitWorktreeDirectoryName,
  gitWorktreeRepositoryDirectoryName,
  isGitHubIssueBranchName,
} from './worktree-names.ts';
import type { GitWorktreeCleanupResult, GitWorktreeResult } from './worktree-service.ts';

export interface TrustedGitHubWorktreeInput {
  agentId: string;
  cloneUrl: string;
  defaultBranch: string;
  itemDatabaseId: number;
  itemNumber: number;
  itemType: 'issue' | 'pull-request';
  repositoryDatabaseId: number;
  signal?: AbortSignal;
}

export interface TrustedGitHubWorktreeResult extends GitWorktreeResult {
  workId: string;
}

export interface TrustedGitHubWorktreePrepareInput extends TrustedGitHubWorktreeInput {
  title: string;
}

export interface TrustedGitHubWorktreeCleanupInput extends TrustedGitHubWorktreeInput {
  worktree: { branch: string; path: string };
}

export interface TrustedGitWorktreeServiceDependencies {
  definition: GitWorktreeToolDefinition;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AgentSystemToolError('invalid_arguments', `${label} must be a positive integer.`);
  }
  return value;
}

function requiredText(value: string, label: string, maximumLength = 256): string {
  const normalized = value.trim();
  const hasControl = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
  if (!normalized || normalized !== value || normalized.length > maximumLength || hasControl) {
    throw new AgentSystemToolError('invalid_arguments', `${label} is invalid.`);
  }
  return normalized;
}

function unavailable(agentId: string, reason: string): AgentSystemToolError {
  return new AgentSystemToolError(
    'capability_not_configured',
    `Git worktree preparation is unavailable for agent ${agentId}: ${reason}.`,
  );
}

/** Inspect or prepare one provider-admitted worktree through the existing Git definition. */
export default class TrustedGitWorktreeService {
  readonly #dependencies: TrustedGitWorktreeServiceDependencies;

  public constructor(dependencies: TrustedGitWorktreeServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async inspectGitHub(
    input: TrustedGitHubWorktreeInput,
  ): Promise<TrustedGitHubWorktreeResult | undefined> {
    const agentId = requiredText(input.agentId, 'The notification agent id');
    const repositoryDatabaseId = positiveInteger(
      input.repositoryDatabaseId,
      'The GitHub repository database id',
    );
    const itemDatabaseId = positiveInteger(
      input.itemDatabaseId,
      'The GitHub work-item database id',
    );
    const itemNumber = positiveInteger(input.itemNumber, 'The GitHub work-item number');
    if (input.itemType !== 'issue' && input.itemType !== 'pull-request') {
      throw new AgentSystemToolError('invalid_arguments', 'The GitHub work-item type is invalid.');
    }
    const repositoryId = `github-${repositoryDatabaseId}`;
    const workId = `${input.itemType}-${itemDatabaseId}`;
    const { result, workspaceDir } = await this.#execute(
      agentId,
      { action: 'list', repositoryId },
      input.signal,
    );
    if (!Array.isArray(result)) {
      throw new AgentSystemToolError(
        'execution_failed',
        'Git worktree inspection returned an unexpected result.',
      );
    }
    const stableName = gitWorktreeDirectoryName(repositoryId, workId);
    const repositoryDirectory = gitWorktreeRepositoryDirectoryName(repositoryId).replace(
      /\.git$/u,
      '',
    );
    const match = result.find(
      (worktree) =>
        worktree.repositoryId === repositoryId &&
        basename(worktree.path) === stableName &&
        basename(dirname(worktree.path)) === repositoryDirectory,
    );
    if (match && match.branch !== stableName) {
      const suffix = gitHubIssueBranchSuffix(agentId, workspaceDir, repositoryId, workId);
      if (
        input.itemType !== 'issue' ||
        !isGitHubIssueBranchName(match.branch, itemNumber, suffix)
      ) {
        throw new AgentSystemToolError(
          'execution_failed',
          'The owned GitHub worktree path uses an unrelated branch.',
        );
      }
    }
    return match ? { ...match, workId } : undefined;
  }

  public async prepareGitHub(
    input: TrustedGitHubWorktreePrepareInput,
  ): Promise<TrustedGitHubWorktreeResult> {
    const agentId = requiredText(input.agentId, 'The notification agent id');
    const defaultBranch = requiredText(input.defaultBranch, 'The GitHub default branch');
    const repositoryDatabaseId = positiveInteger(
      input.repositoryDatabaseId,
      'The GitHub repository database id',
    );
    const itemDatabaseId = positiveInteger(
      input.itemDatabaseId,
      'The GitHub work-item database id',
    );
    const itemNumber = positiveInteger(input.itemNumber, 'The GitHub work-item number');
    if (input.itemType !== 'issue' && input.itemType !== 'pull-request') {
      throw new AgentSystemToolError('invalid_arguments', 'The GitHub work-item type is invalid.');
    }
    const repositoryId = `github-${repositoryDatabaseId}`;
    const workId = `${input.itemType}-${itemDatabaseId}`;
    const toolInput = {
      action: 'prepare' as const,
      baseRef: `origin/${defaultBranch}`,
      repository: {
        cloneUrl: requiredText(input.cloneUrl, 'The GitHub clone URL', 4096),
        id: repositoryId,
      },
      workId,
    };

    const { result } = await this.#execute(
      agentId,
      toolInput,
      input.signal,
      input.itemType === 'issue' ? { number: itemNumber, title: input.title } : undefined,
    );
    if (
      Array.isArray(result) ||
      !result.workId ||
      result.workId !== workId ||
      result.repositoryId !== repositoryId
    ) {
      throw new AgentSystemToolError(
        'execution_failed',
        'Git worktree preparation returned an unexpected identity.',
      );
    }
    return { ...result, workId };
  }

  public async cleanupGitHub(
    input: TrustedGitHubWorktreeCleanupInput,
  ): Promise<GitWorktreeCleanupResult> {
    const observed = await this.inspectGitHub(input);
    const repositoryId = `github-${positiveInteger(
      input.repositoryDatabaseId,
      'The GitHub repository database id',
    )}`;
    const workId = `${input.itemType}-${positiveInteger(
      input.itemDatabaseId,
      'The GitHub work-item database id',
    )}`;
    if (!observed) {
      return {
        branch: input.worktree.branch,
        path: input.worktree.path,
        repositoryId,
        status: 'missing',
        workId,
      };
    }
    if (observed.branch !== input.worktree.branch || observed.path !== input.worktree.path) {
      return {
        branch: input.worktree.branch,
        path: input.worktree.path,
        repositoryId,
        status: 'unsafe',
        workId,
      };
    }
    return this.#executeCleanup(input.agentId, repositoryId, workId, observed.branch, input.signal);
  }

  async #executeCleanup(
    agentId: string,
    repositoryId: string,
    workId: string,
    expectedBranch: string,
    signal?: AbortSignal,
  ): Promise<GitWorktreeCleanupResult> {
    const loaded = await this.#dependencies.manifestService.loadForAgentId(agentId, 'service');
    if (loaded.status !== 'loaded' || loaded.manifest.agent.id !== agentId) {
      throw unavailable(agentId, 'the trusted manifest is not loaded');
    }
    const declared = this.#dependencies.definition.configuration.read(loaded.manifest);
    if (!declared) throw unavailable(agentId, 'Git worktrees are not configured');
    const operation = {
      action: 'git.worktree.remove',
      risk: 'write' as const,
      resources: [
        { type: 'git-repository', id: repositoryId },
        { type: 'git-worktree', id: workId },
      ],
      summary: 'Remove a clean retired GitHub worktree',
    };
    const authorization = await this.#dependencies.definition.authorization?.authorize?.(
      operation,
      declared,
    );
    if (authorization?.status !== 'allowed') {
      throw new AgentSystemToolError(
        'approval_denied',
        authorization?.reason ?? 'Git worktree cleanup is not authorized.',
      );
    }
    const environment = await this.#dependencies.environmentService.loadForAgentId(
      agentId,
      'service',
    );
    if (
      environment.status !== 'loaded' ||
      resolve(environment.scope.workspaceDir) !== resolve(loaded.scope.workspaceDir)
    ) {
      throw new AgentSystemToolError(
        'credential_unavailable',
        `The Git worktree environment is unavailable for agent ${agentId}.`,
        false,
        environment.status === 'loaded'
          ? undefined
          : environment.diagnostics.find((entry) => entry.providerDiagnostic)?.providerDiagnostic,
      );
    }
    const values = environment.environment.values;
    const configuration = this.#dependencies.definition.configuration.resolve(declared, {
      resolve(value, fieldPath) {
        const resolution = resolveManifestValue(value, values, fieldPath);
        if (resolution.status === 'invalid') {
          throw new AgentSystemToolError('credential_unavailable', resolution.diagnostic.message);
        }
        return resolution.value;
      },
    });
    return this.#dependencies.definition.executeTrustedGitHubCleanup(
      { repositoryId, workId },
      configuration,
      {
        agentId,
        resolveEnvironment(name: string) {
          return values[name];
        },
        ...(signal === undefined ? {} : { signal }),
        source: 'command',
        workspaceDir: loaded.scope.workspaceDir,
      },
      expectedBranch,
    );
  }

  async #execute(
    agentId: string,
    toolInput: GitWorktreeToolInput,
    signal?: AbortSignal,
    issueBranch?: { number: number; title: string },
  ): Promise<{ result: GitWorktreeResult | GitWorktreeResult[]; workspaceDir: string }> {
    const loaded = await this.#dependencies.manifestService.loadForAgentId(agentId, 'service');
    if (loaded.status !== 'loaded' || loaded.manifest.agent.id !== agentId) {
      throw unavailable(agentId, 'the trusted manifest is not loaded');
    }
    const declared = this.#dependencies.definition.configuration.read(loaded.manifest);
    if (!declared) throw unavailable(agentId, 'Git worktrees are not configured');
    try {
      this.#dependencies.definition.tool.validate?.(toolInput, declared);
    } catch {
      throw new AgentSystemToolError(
        'invalid_arguments',
        'The provider-derived Git worktree request is invalid.',
      );
    }
    const operation = this.#dependencies.definition.tool.classify(toolInput, declared);
    const authorization = await this.#dependencies.definition.authorization?.authorize?.(
      operation,
      declared,
    );
    if (authorization?.status !== 'allowed') {
      throw new AgentSystemToolError(
        'approval_denied',
        authorization?.reason ?? 'Git worktree preparation is not authorized.',
      );
    }

    const environment = await this.#dependencies.environmentService.loadForAgentId(
      agentId,
      'service',
    );
    if (
      environment.status !== 'loaded' ||
      resolve(environment.scope.workspaceDir) !== resolve(loaded.scope.workspaceDir)
    ) {
      throw new AgentSystemToolError(
        'credential_unavailable',
        `The Git worktree environment is unavailable for agent ${agentId}.`,
        false,
        environment.status === 'loaded'
          ? undefined
          : environment.diagnostics.find((entry) => entry.providerDiagnostic)?.providerDiagnostic,
      );
    }
    const values = environment.environment.values;
    const configuration = this.#dependencies.definition.configuration.resolve(declared, {
      resolve(value, fieldPath) {
        const resolution = resolveManifestValue(value, values, fieldPath);
        if (resolution.status === 'invalid') {
          throw new AgentSystemToolError('credential_unavailable', resolution.diagnostic.message);
        }
        return resolution.value;
      },
    });
    const scope = {
      agentId,
      resolveEnvironment(name: string) {
        return values[name];
      },
      ...(signal === undefined ? {} : { signal }),
      source: 'command' as const,
      workspaceDir: loaded.scope.workspaceDir,
    };
    const result =
      toolInput.action === 'prepare'
        ? await this.#dependencies.definition.executeTrustedGitHubPrepare(
            toolInput,
            configuration,
            scope,
            issueBranch === undefined
              ? undefined
              : {
                  ...issueBranch,
                  suffix: gitHubIssueBranchSuffix(
                    agentId,
                    scope.workspaceDir,
                    toolInput.repository.id,
                    toolInput.workId,
                  ),
                },
          )
        : await this.#dependencies.definition.execute(toolInput, configuration, scope);
    return { result, workspaceDir: scope.workspaceDir };
  }
}
