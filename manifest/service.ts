import { AsyncLocalStorage } from 'node:async_hooks';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import discoverManifest, { discoverManifestFromDirectory } from './discover.ts';
import {
  invalidManifestResult,
  loadDiscoveredManifest,
  type AgentManifestLoadResult,
  type AgentManifestValidationCheck,
} from './load.ts';
import type { AgentManifest, ManifestDiagnostic } from './types.ts';
import resolveAgentId, { type AgentRuntimeContext } from '../agent/resolve-id.ts';

export type {
  AgentManifestLoadResult,
  AgentManifestScope,
  AgentManifestValidationCheck,
} from './load.ts';

export type ManifestLoadTrigger =
  | 'before_prompt_build'
  | 'before_tool_call'
  | 'cli'
  | 'resolve_exec_env'
  | 'service'
  | 'session_start';

export interface AgentManifestServiceDependencies {
  getConfig(): ReturnType<OpenClawPluginApi['runtime']['config']['current']>;
  logger: {
    debug?(message: string): void;
    error(message: string): void;
    info(message: string): void;
    warn(message: string): void;
  };
  parseSessionAgentId(sessionKey: string): string | undefined;
  resolveAgentWorkspaceDir(
    config: ReturnType<OpenClawPluginApi['runtime']['config']['current']>,
    agentId: string,
  ): string;
  validateManifest?(
    manifest: AgentManifest,
    workspaceDir: string,
  ): {
    checks: AgentManifestValidationCheck[];
    diagnostics: ManifestDiagnostic[];
  };
}

interface CacheEntry {
  fingerprint: string;
  result: AgentManifestLoadResult;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function diagnosticCodes(diagnostics: ManifestDiagnostic[]): string {
  return diagnostics.map(({ code }) => code).join(',');
}

/** Own manifest resolution, parsing, cache invalidation, and redacted runtime diagnostics. */
export default class AgentManifestService {
  readonly #snapshot = new AsyncLocalStorage<{
    loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }>;
    signal: AbortSignal;
  }>();

  /** Constrain nested lifecycle consumers to the approved declaration, including credential reads. */
  withSnapshot<T>(
    loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }>,
    signal: AbortSignal,
    execute: () => Promise<T>,
  ): Promise<T> {
    return this.#snapshot.run({ loaded, signal }, execute);
  }
  readonly #dependencies: AgentManifestServiceDependencies;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<AgentManifestLoadResult>>();
  readonly #unresolvedTriggers = new Set<ManifestLoadTrigger>();

  constructor(dependencies: AgentManifestServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async loadForRuntimeContext(
    context: AgentRuntimeContext,
    trigger: Exclude<ManifestLoadTrigger, 'cli'>,
  ): Promise<AgentManifestLoadResult> {
    try {
      const agentId = resolveAgentId(context, this.#dependencies.parseSessionAgentId);
      if (!agentId) {
        this.#logUnresolved(trigger);
        return { status: 'unresolved', diagnostics: [] };
      }

      return await this.loadForAgentId(agentId, trigger);
    } catch {
      this.#dependencies.logger.error(`manifest_scope_failed trigger=${quote(trigger)}`);
      return {
        status: 'unresolved',
        diagnostics: [
          {
            code: 'agent-scope-resolution',
            message: 'The active OpenClaw agent workspace could not be resolved.',
            severity: 'error',
          },
        ],
      };
    }
  }

  async loadForAgentId(
    agentId: string,
    trigger: ManifestLoadTrigger = 'cli',
  ): Promise<AgentManifestLoadResult> {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) {
      return {
        status: 'unresolved',
        diagnostics: [
          {
            code: 'agent-id-required',
            message: 'An agent id is required.',
            severity: 'error',
          },
        ],
      };
    }

    try {
      const config = this.#dependencies.getConfig();
      const workspaceDir = this.#dependencies.resolveAgentWorkspaceDir(config, normalizedAgentId);
      return await this.loadForWorkspace(workspaceDir, normalizedAgentId, trigger);
    } catch {
      this.#dependencies.logger.error(
        `manifest_scope_failed trigger=${quote(trigger)} agentId=${quote(normalizedAgentId)}`,
      );
      return {
        status: 'unresolved',
        diagnostics: [
          {
            code: 'agent-workspace-resolution',
            message: `The workspace for agent ${normalizedAgentId} could not be resolved.`,
            severity: 'error',
          },
        ],
      };
    }
  }

  async loadForWorkspace(
    workspaceDir: string,
    expectedAgentId?: string,
    trigger: ManifestLoadTrigger = 'cli',
  ): Promise<AgentManifestLoadResult> {
    const snapshot = this.#snapshot.getStore();
    snapshot?.signal.throwIfAborted();
    const result = await this.#loadForWorkspace(workspaceDir, expectedAgentId, trigger);
    if (snapshot) {
      snapshot.signal.throwIfAborted();
      const approved = snapshot.loaded;
      if (
        result.status !== 'loaded' ||
        result.digest !== approved.digest ||
        result.path !== approved.path ||
        result.scope.workspaceDir !== approved.scope.workspaceDir ||
        result.manifest.agent.id !== approved.manifest.agent.id
      ) {
        return invalidManifestResult({ workspaceDir, agentId: expectedAgentId }, [
          {
            code: 'manifest-approval-changed',
            message: 'The manifest no longer matches the approved lifecycle operation.',
            severity: 'error',
          },
        ]);
      }
      return { ...result, manifest: structuredClone(approved.manifest) };
    }
    return result;
  }

  async #loadForWorkspace(
    workspaceDir: string,
    expectedAgentId: string | undefined,
    trigger: ManifestLoadTrigger,
  ): Promise<AgentManifestLoadResult> {
    const discovery = await discoverManifest(workspaceDir);
    const cacheKey = `${discovery.workspaceDir}\u0000${expectedAgentId ?? ''}`;
    const cached = this.#cache.get(cacheKey);
    if (cached?.fingerprint === discovery.fingerprint) return cached.result;

    const inFlightKey = `${cacheKey}\u0000${discovery.fingerprint}`;
    const existingLoad = this.#inFlight.get(inFlightKey);
    if (existingLoad) return existingLoad;

    const load = loadDiscoveredManifest(discovery, {
      ...(expectedAgentId === undefined ? {} : { expectedAgentId }),
      ...(this.#dependencies.validateManifest === undefined
        ? {}
        : { validateManifest: this.#dependencies.validateManifest }),
    })
      .then((result) => {
        this.#cache.set(cacheKey, { fingerprint: discovery.fingerprint, result });
        this.#logResult(result, cached?.result, trigger, discovery.ignoredPath);
        return result;
      })
      .catch(() => {
        const result = invalidManifestResult(
          { agentId: expectedAgentId, workspaceDir: discovery.workspaceDir },
          [
            {
              code: 'manifest-load-failed',
              message: 'The manifest could not be loaded.',
              severity: 'error',
            },
          ],
          discovery.selected?.path,
        );
        this.#cache.set(cacheKey, { fingerprint: discovery.fingerprint, result });
        this.#logResult(result, cached?.result, trigger, discovery.ignoredPath);
        return result;
      })
      .finally(() => {
        if (this.#inFlight.get(inFlightKey) === load) this.#inFlight.delete(inFlightKey);
      });

    this.#inFlight.set(inFlightKey, load);
    return load;
  }

  async loadForCommandDirectory(
    commandDirectory: string,
    trigger: ManifestLoadTrigger = 'cli',
  ): Promise<AgentManifestLoadResult> {
    const discovery = await discoverManifestFromDirectory(commandDirectory);
    return this.loadForWorkspace(discovery.workspaceDir, undefined, trigger);
  }

  #logUnresolved(trigger: ManifestLoadTrigger): void {
    if (this.#unresolvedTriggers.has(trigger)) return;
    this.#unresolvedTriggers.add(trigger);
    this.#dependencies.logger.debug?.(`manifest_scope_unresolved trigger=${quote(trigger)}`);
  }

  #logResult(
    result: AgentManifestLoadResult,
    previous: AgentManifestLoadResult | undefined,
    trigger: ManifestLoadTrigger,
    ignoredPath?: string,
  ): void {
    if (result.status === 'unresolved') return;

    const agentAttribute =
      result.scope.agentId === undefined ? '' : ` agentId=${quote(result.scope.agentId)}`;
    if (result.status === 'unmanaged') {
      this.#dependencies.logger.debug?.(
        `manifest_absent trigger=${quote(trigger)}${agentAttribute} workspace=${quote(result.scope.workspaceDir)}`,
      );
      return;
    }

    if (ignoredPath) {
      this.#dependencies.logger.warn(
        `manifest_shadowed selected=${quote(result.path ?? '')} ignored=${quote(ignoredPath)}`,
      );
    }

    if (result.status === 'invalid') {
      this.#dependencies.logger.error(
        `manifest_invalid trigger=${quote(trigger)}${agentAttribute} path=${quote(result.path ?? '')} codes=${quote(diagnosticCodes(result.diagnostics))}`,
      );
      return;
    }

    const event =
      previous?.status === 'loaded' && previous.digest !== result.digest
        ? 'manifest_changed'
        : 'manifest_loaded';
    this.#dependencies.logger.info(
      `${event} trigger=${quote(trigger)}${agentAttribute} path=${quote(result.path)} schemaVersion=${result.manifest.schemaVersion} digest=${quote(result.digest)}`,
    );
  }
}
