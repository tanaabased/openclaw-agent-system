import { resolve } from 'node:path';

import type AgentEnvironmentService from '../../lib/agent-environment-service.ts';
import type AgentManifestService from '../../lib/agent-manifest-service.ts';
import AgentSystemToolError from '../../lib/tool-error.ts';
import resolveManifestValue from '../../utils/resolve-manifest-value.ts';
import type { GitWorktreeToolDefinition } from './worktree-tool.ts';
import type { GitWorktreeResult } from './worktree-service.ts';

export interface TrustedGitHubWorktreeInput {
  agentId: string;
  cloneUrl: string;
  defaultBranch: string;
  itemDatabaseId: number;
  itemType: 'issue' | 'pull-request';
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

/** Prepare one provider-admitted GitHub worktree through the existing Git definition. */
export default class TrustedGitWorktreeService {
  readonly #dependencies: TrustedGitWorktreeServiceDependencies;

  public constructor(dependencies: TrustedGitWorktreeServiceDependencies) {
    this.#dependencies = dependencies;
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
    const result = await this.#dependencies.definition.execute(toolInput, configuration, {
      agentId,
      resolveEnvironment(name) {
        return values[name];
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      source: 'command',
      workspaceDir: loaded.scope.workspaceDir,
    });
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
}
