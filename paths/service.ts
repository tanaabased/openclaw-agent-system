import declaredShims, { declaredShimDirectory } from './declared-shims.ts';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type { AgentManifest } from '../manifest/types.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import { configuredAgentValue } from '../core/configured-agents.ts';
import resolveAgentPaths, { type AgentPathProjection } from './resolve.ts';
import type CodexPathConfigService from './codex-config-service.ts';
import type PathProjectionStore from './projection-store.ts';

export type AgentPathInstallAction =
  | 'create-workspace-bin'
  | 'reconcile-declared-shims'
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
  codexBaseline: {
    added: string[];
    operation: 'append' | 'rebuild';
    removed: string[];
  };
  codexStatus: 'managed' | 'manual';
  projection: AgentPathProjection;
  warnings: AgentPathWarning[];
}

export interface AgentPathServiceDependencies {
  shimRoot?: string;
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
  rebuildCodexPath?: boolean;
  workspaceDir: string;
}

function findAgent(config: OpenClawConfig, agentId: string) {
  return configuredAgentValue(config, agentId);
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
    const previous = await this.#dependencies.projectionStore.read(
      agentId,
      workspaceDir,
      input.manifest.storage?.backend,
    );
    const previousOwned =
      previous && resolve(previous.workspaceDir) === workspaceDir ? previous.openClawPaths : [];
    const shimDirectory =
      this.#dependencies.shimRoot && declaredShimDirectory(this.#dependencies.shimRoot, agentId);
    const ids = Object.keys(input.manifest.tools ?? {});
    const shimsChanged =
      shimDirectory &&
      (await declaredShims(
        shimDirectory,
        join(this.#dependencies.packageDir, 'bin', 'agent-system-tool'),
        ids,
        true,
      ));
    const desiredPaths = projection.entries.flatMap(({ path, source }) =>
      source === 'agent-system.bin' && ids.length && shimDirectory ? [shimDirectory, path] : [path],
    );
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
    const codex = await this.#dependencies.codexConfigService.reconcile(workspaceDir, projection, {
      previousManagedPaths: previousOwned,
      rebuildBaseline: input.rebuildCodexPath === true,
    });
    if (codex.status !== 'manual') {
      const verification = await this.#dependencies.codexConfigService.inspect(
        workspaceDir,
        projection,
        {
          previousManagedPaths: previousOwned,
        },
      );
      if (
        !verification.pathMatches ||
        !verification.loginShellDisabled ||
        !verification.gitignored
      ) {
        throw new AgentSystemLifecycleError(
          'path',
          'codex-path-verification-failed',
          `Codex execution configuration for ${agentId} did not match after installation.`,
        );
      }
    }
    await this.#dependencies.projectionStore.write(
      {
        schemaVersion: 1,
        agentId,
        workspaceDir,
        openClawPaths: desiredPaths,
      },
      input.manifest.storage?.backend,
    );

    const actions: AgentPathInstallAction[] = [];
    if (shimsChanged) actions.push('reconcile-declared-shims');
    if (createdWorkspaceBin) actions.push('create-workspace-bin');
    if (mutation.result === true) actions.push('set-exec-path');
    if (codex.status === 'created') actions.push('create-codex-config');
    else if (codex.status === 'updated') actions.push('update-codex-config');
    if (codex.gitignoreUpdated) actions.push('update-gitignore');
    return {
      actions,
      codexBaseline: {
        added: codex.baselineAdded,
        operation: codex.operation,
        removed: codex.baselineRemoved,
      },
      codexStatus: codex.status === 'manual' ? 'manual' : 'managed',
      projection,
      warnings:
        codex.status === 'manual'
          ? [
              {
                code: 'codex-config-user-managed',
                message:
                  'The existing .codex/config.toml is user-managed; add allow_login_shell = false and the Agent System PATH entries manually as documented in MANIFEST.md#path.',
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
    const previous = await this.#dependencies.projectionStore.read(
      input.manifest.agent.id,
      input.workspaceDir,
      input.manifest.storage?.backend,
    );
    const previousManagedPaths =
      previous && resolve(previous.workspaceDir) === resolve(input.workspaceDir)
        ? previous.openClawPaths
        : [];
    const config = await this.#dependencies.readConfig();
    const currentPaths = configuredPaths(config, input.manifest.agent.id);
    const shimDirectory =
      this.#dependencies.shimRoot &&
      declaredShimDirectory(this.#dependencies.shimRoot, input.manifest.agent.id);
    const ids = Object.keys(input.manifest.tools ?? {});
    const shimDrift =
      shimDirectory &&
      (await declaredShims(
        shimDirectory,
        join(this.#dependencies.packageDir, 'bin', 'agent-system-tool'),
        ids,
        false,
      ));
    const expectedPaths = projection.entries.flatMap(({ path, source }) =>
      source === 'agent-system.bin' && ids.length && shimDirectory ? [shimDirectory, path] : [path],
    );
    return {
      codex: await this.#dependencies.codexConfigService.inspect(input.workspaceDir, projection, {
        previousManagedPaths,
      }),
      openClawMatches:
        !shimDrift && expectedPaths.every((path, index) => currentPaths[index] === path),
      projection,
    };
  }
}
