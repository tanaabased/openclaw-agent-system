import { resolve } from 'node:path';

import type AgentEnvironmentService from '../../lib/agent-environment-service.ts';
import type AgentManifestService from '../../lib/agent-manifest-service.ts';
import AgentSystemToolError from '../../lib/tool-error.ts';
import resolveManifestValue from '../../utils/resolve-manifest-value.ts';
import type { GitWorktreeToolDefinition } from './worktree-tool.ts';
import type { GitWorktreeToolInput } from './worktree-tool-schema.ts';
import { gitWorktreeDirectoryName } from './worktree-names.ts';
import { githubSshWorktreeRemote } from './worktree-remote.ts';
import type { GitWorktreeResult } from './worktree-service.ts';

export interface TrustedGitHubWorktreeInput {
  agentId: string;
  cloneUrl: string;
  defaultBranch: string;
  itemDatabaseId: number;
  itemNumber: number;
  itemType: 'issue' | 'pull-request';
  pullRequestHeadSha?: string;
  repositoryDatabaseId: number;
  signal?: AbortSignal;
}

export interface TrustedGitHubWorktreeResult extends GitWorktreeResult {
  workId: string;
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
    if (input.itemType !== 'issue' && input.itemType !== 'pull-request') {
      throw new AgentSystemToolError('invalid_arguments', 'The GitHub work-item type is invalid.');
    }
    const repositoryId = `github-${repositoryDatabaseId}`;
    const workId = `${input.itemType}-${itemDatabaseId}`;
    const result = await this.#execute(agentId, { action: 'list', repositoryId }, input.signal);
    if (!Array.isArray(result)) {
      throw new AgentSystemToolError(
        'execution_failed',
        'Git worktree inspection returned an unexpected result.',
      );
    }
    const branch = gitWorktreeDirectoryName(repositoryId, workId);
    const match = result.find(
      (worktree) => worktree.repositoryId === repositoryId && worktree.branch === branch,
    );
    return match ? { ...match, workId } : undefined;
  }

  public async prepareGitHub(
    input: TrustedGitHubWorktreeInput,
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
    const pullRequestHeadSha = input.pullRequestHeadSha?.trim().toLowerCase();
    if (
      (input.itemType === 'pull-request' &&
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(pullRequestHeadSha ?? '')) ||
      (input.itemType === 'issue' && input.pullRequestHeadSha !== undefined)
    ) {
      throw new AgentSystemToolError(
        'invalid_arguments',
        'The GitHub pull-request head sha is invalid.',
      );
    }
    const baseRef =
      input.itemType === 'pull-request'
        ? `refs/remotes/origin/pull/${itemNumber}/head`
        : `origin/${defaultBranch}`;
    const toolInput = {
      action: 'prepare' as const,
      baseRef,
      repository: {
        cloneUrl: requiredText(input.cloneUrl, 'The GitHub clone URL', 4096),
        id: repositoryId,
      },
      workId,
    };

    const result = await this.#execute(
      agentId,
      toolInput,
      input.signal,
      input.itemType === 'pull-request'
        ? {
            baseRef,
            cloneUrl: toolInput.repository.cloneUrl,
            expectedCommit: pullRequestHeadSha!,
            fetchRef: {
              destination: baseRef,
              source: `refs/pull/${itemNumber}/head`,
            },
            repositoryId,
            workId,
          }
        : undefined,
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

  async #execute(
    agentId: string,
    toolInput: GitWorktreeToolInput,
    signal?: AbortSignal,
    trustedPrepare?: Parameters<GitWorktreeToolDefinition['prepareTrusted']>[0],
  ): Promise<GitWorktreeResult | GitWorktreeResult[]> {
    const loaded = await this.#dependencies.manifestService.loadForAgentId(agentId, 'service');
    if (loaded.status !== 'loaded' || loaded.manifest.agent.id !== agentId) {
      throw unavailable(agentId, 'the trusted manifest is not loaded');
    }
    const declared = this.#dependencies.definition.configuration.read(loaded.manifest);
    if (!declared) throw unavailable(agentId, 'Git worktrees are not configured');
    const executionInput =
      toolInput.action === 'prepare' && declared.git.ssh && toolInput.repository.cloneUrl
        ? {
            ...toolInput,
            repository: {
              ...toolInput.repository,
              cloneUrl: githubSshWorktreeRemote(toolInput.repository.cloneUrl),
            },
          }
        : toolInput;
    try {
      this.#dependencies.definition.tool.validate?.(executionInput, declared);
    } catch {
      throw new AgentSystemToolError(
        'invalid_arguments',
        'The provider-derived Git worktree request is invalid.',
      );
    }
    const operation = this.#dependencies.definition.tool.classify(executionInput, declared);
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
      source: 'command',
      workspaceDir: loaded.scope.workspaceDir,
    } as const;
    if (!trustedPrepare) {
      return this.#dependencies.definition.execute(executionInput, configuration, scope);
    }
    const trustedInput =
      declared.git.ssh && trustedPrepare.cloneUrl
        ? {
            ...trustedPrepare,
            cloneUrl: githubSshWorktreeRemote(trustedPrepare.cloneUrl),
          }
        : trustedPrepare;
    return this.#dependencies.definition.prepareTrusted(trustedInput, configuration, scope);
  }
}
