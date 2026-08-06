import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import type { AgentManifest } from '../utils/manifest-types.ts';
import resolveAgentPaths, { type AgentPathProjection } from '../utils/resolve-agent-paths.ts';
import type CodexPathConfigService from './codex-path-config-service.ts';
import type PathProjectionStore from './path-projection-store.ts';

export type AgentPathInstallAction =
  | 'create-workspace-bin'
  | 'set-exec-path'
  | 'create-codex-config'
  | 'update-codex-config'
  | 'update-gitignore';

export interface AgentPathWarning {
  code: string;
  message: string;
}

export interface AgentPathInstallResult {
  actions: AgentPathInstallAction[];
  codexStatus: 'managed' | 'manual';
  projection: AgentPathProjection;
  warnings: AgentPathWarning[];
}

export interface AgentPathServiceDependencies {
  basePath: string;
  codexConfigService: Pick<CodexPathConfigService, 'inspect' | 'reconcile'>;
  mutateConfigFile(params: {
    afterWrite: { mode: 'auto' };
    base: 'source';
    mutate(config: OpenClawConfig): boolean | void;
  }): Promise<{ result?: boolean }>;
  packageDir: string;
  projectionStore: Pick<PathProjectionStore, 'read' | 'write'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

export interface AgentPathInput {
  manifest: AgentManifest;
  workspaceDir: string;
}

function findAgent(config: OpenClawConfig, agentId: string) {
  return config.agents?.list?.find((entry) => entry.id.trim().toLowerCase() === agentId);
}

function configuredPaths(config: OpenClawConfig, agentId: string): string[] {
  return [...(findAgent(config, agentId)?.tools?.exec?.pathPrepend ?? [])];
}

/** Reconcile the two explicitly supported generic command path surfaces. */
export default class AgentPathService {
  readonly #dependencies: AgentPathServiceDependencies;

  constructor(dependencies: AgentPathServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async reconcile(input: AgentPathInput): Promise<AgentPathInstallResult> {
    const workspaceDir = resolve(input.workspaceDir);
    const workspaceBin = join(workspaceDir, 'bin');
    let createdWorkspaceBin = false;
    try {
      const stats = await lstat(workspaceBin);
      if (!stats.isDirectory()) {
        throw new Error('The workspace bin path must be a real directory.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(workspaceBin);
      createdWorkspaceBin = true;
    }

    const resolution = await resolveAgentPaths(input.manifest, {
      basePath: this.#dependencies.basePath,
      packageDir: this.#dependencies.packageDir,
      workspaceDir,
    });
    if (resolution.status === 'invalid') {
      throw new Error(resolution.diagnostics.map(({ message }) => message).join(' '));
    }
    const { projection } = resolution;
    const agentId = input.manifest.agent.id;
    const previous = await this.#dependencies.projectionStore.read(agentId);
    const previousOwned =
      previous && resolve(previous.workspaceDir) === workspaceDir ? previous.openClawPaths : [];
    const desiredPaths = projection.entries.map(({ path }) => path);
    const mutation = await this.#dependencies.mutateConfigFile({
      base: 'source',
      afterWrite: { mode: 'auto' },
      mutate(config) {
        const agent = findAgent(config, agentId);
        if (!agent) throw new Error(`OpenClaw agent ${agentId} is unavailable for path setup.`);
        const currentPaths = [...(agent.tools?.exec?.pathPrepend ?? [])];
        const owned = new Set([...previousOwned, ...desiredPaths]);
        const preservedPaths = currentPaths.filter((path) => !owned.has(path));
        const nextPaths = [...desiredPaths, ...preservedPaths];
        if (
          currentPaths.length === nextPaths.length &&
          currentPaths.every((path, index) => path === nextPaths[index])
        ) {
          return false;
        }
        agent.tools ??= {};
        agent.tools.exec ??= {};
        agent.tools.exec.pathPrepend = nextPaths;
        return true;
      },
    });
    const codex = await this.#dependencies.codexConfigService.reconcile(workspaceDir, projection);
    await this.#dependencies.projectionStore.write({
      schemaVersion: 1,
      agentId,
      workspaceDir,
      openClawPaths: desiredPaths,
    });

    const actions: AgentPathInstallAction[] = [];
    if (createdWorkspaceBin) actions.push('create-workspace-bin');
    if (mutation.result === true) actions.push('set-exec-path');
    if (codex.status === 'created') actions.push('create-codex-config');
    else if (codex.status === 'updated') actions.push('update-codex-config');
    if (codex.gitignoreUpdated) actions.push('update-gitignore');
    return {
      actions,
      codexStatus: codex.status === 'manual' ? 'manual' : 'managed',
      projection,
      warnings:
        codex.status === 'manual'
          ? [
              {
                code: 'codex-config-user-managed',
                message:
                  'The existing .codex/config.toml is user-managed; add the Agent System PATH entries manually as documented in ADVANCED.md.',
              },
            ]
          : [],
    };
  }

  async inspect(input: AgentPathInput): Promise<{
    codex: Awaited<ReturnType<CodexPathConfigService['inspect']>>;
    openClawMatches: boolean;
    projection: AgentPathProjection;
  }> {
    const resolution = await resolveAgentPaths(input.manifest, {
      basePath: this.#dependencies.basePath,
      packageDir: this.#dependencies.packageDir,
      workspaceDir: input.workspaceDir,
    });
    if (resolution.status === 'invalid') {
      throw new Error(resolution.diagnostics.map(({ message }) => message).join(' '));
    }
    const { projection } = resolution;
    const config = await this.#dependencies.readConfig();
    const currentPaths = configuredPaths(config, input.manifest.agent.id);
    const expectedPaths = projection.entries.map(({ path }) => path);
    return {
      codex: await this.#dependencies.codexConfigService.inspect(input.workspaceDir, projection),
      openClawMatches: expectedPaths.every((path, index) => currentPaths[index] === path),
      projection,
    };
  }
}
