import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import discoverManifest, {
  maximumManifestBytes,
  type ManifestDiscovery,
} from '../utils/discover-manifest.ts';
import type { AgentManifest, ManifestDiagnostic } from '../utils/manifest-types.ts';
import parseAgentManifest from '../utils/parse-agent-manifest.ts';
import resolveAgentId, { type AgentRuntimeContext } from '../utils/resolve-agent-id.ts';

export type ManifestLoadTrigger = 'before_tool_call' | 'cli' | 'session_start';

export interface AgentManifestScope {
  agentId?: string;
  workspaceDir: string;
}

export type AgentManifestLoadResult =
  | {
      status: 'unresolved';
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'unmanaged';
      scope: AgentManifestScope;
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'invalid';
      scope: AgentManifestScope;
      path?: string;
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'loaded';
      scope: AgentManifestScope;
      path: string;
      digest: string;
      manifest: AgentManifest;
      diagnostics: ManifestDiagnostic[];
    };

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

function invalidResult(
  scope: AgentManifestScope,
  diagnostics: ManifestDiagnostic[],
  path?: string,
): AgentManifestLoadResult {
  return {
    status: 'invalid',
    scope,
    ...(path === undefined ? {} : { path }),
    diagnostics,
  };
}

/** Own manifest resolution, parsing, cache invalidation, and redacted runtime diagnostics. */
export default class AgentManifestService {
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
      this.#dependencies.logger.error(
        `agent_system.manifest_scope_failed trigger=${quote(trigger)}`,
      );
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
        `agent_system.manifest_scope_failed trigger=${quote(trigger)} agentId=${quote(normalizedAgentId)}`,
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
    const discovery = await discoverManifest(workspaceDir);
    const cacheKey = `${discovery.workspaceDir}\u0000${expectedAgentId ?? ''}`;
    const cached = this.#cache.get(cacheKey);
    if (cached?.fingerprint === discovery.fingerprint) return cached.result;

    const inFlightKey = `${cacheKey}\u0000${discovery.fingerprint}`;
    const existingLoad = this.#inFlight.get(inFlightKey);
    if (existingLoad) return existingLoad;

    const load = this.#loadDiscovered(discovery, expectedAgentId)
      .then((result) => {
        this.#cache.set(cacheKey, { fingerprint: discovery.fingerprint, result });
        this.#logResult(result, cached?.result, trigger, discovery.ignoredPath);
        return result;
      })
      .catch(() => {
        const result = invalidResult(
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

  async #loadDiscovered(
    discovery: ManifestDiscovery,
    expectedAgentId?: string,
  ): Promise<AgentManifestLoadResult> {
    const scope: AgentManifestScope = {
      ...(expectedAgentId === undefined ? {} : { agentId: expectedAgentId }),
      workspaceDir: discovery.workspaceDir,
    };
    const selected = discovery.selected;

    if (!selected) return { status: 'unmanaged', scope, diagnostics: [] };
    if (selected.status === 'invalid') {
      return invalidResult(scope, discovery.diagnostics, selected.path);
    }

    const contents = await readFile(selected.path);
    if (contents.byteLength > maximumManifestBytes) {
      return invalidResult(
        scope,
        [
          ...discovery.diagnostics,
          {
            code: 'manifest-too-large',
            message: `The manifest exceeds the ${maximumManifestBytes}-byte size limit.`,
            severity: 'error',
          },
        ],
        selected.path,
      );
    }

    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    } catch {
      return invalidResult(
        scope,
        [
          ...discovery.diagnostics,
          {
            code: 'manifest-encoding',
            message: 'The manifest must be valid UTF-8.',
            severity: 'error',
          },
        ],
        selected.path,
      );
    }

    const digest = createHash('sha256').update(contents).digest('hex').slice(0, 12);
    const parsed = parseAgentManifest(source);
    if (parsed.status === 'invalid') {
      return invalidResult(scope, [...discovery.diagnostics, ...parsed.diagnostics], selected.path);
    }

    if (expectedAgentId && parsed.manifest.agent.id !== expectedAgentId) {
      return invalidResult(
        scope,
        [
          ...discovery.diagnostics,
          {
            code: 'agent-id-mismatch',
            fieldPath: '/agent/id',
            message: `Manifest agent id ${parsed.manifest.agent.id} does not match OpenClaw agent ${expectedAgentId}.`,
            severity: 'error',
          },
        ],
        selected.path,
      );
    }

    return {
      status: 'loaded',
      scope,
      path: selected.path,
      digest,
      manifest: parsed.manifest,
      diagnostics: discovery.diagnostics,
    };
  }

  #logUnresolved(trigger: ManifestLoadTrigger): void {
    if (this.#unresolvedTriggers.has(trigger)) return;
    this.#unresolvedTriggers.add(trigger);
    this.#dependencies.logger.debug?.(
      `agent_system.manifest_scope_unresolved trigger=${quote(trigger)}`,
    );
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
        `agent_system.manifest_absent trigger=${quote(trigger)}${agentAttribute} workspace=${quote(result.scope.workspaceDir)}`,
      );
      return;
    }

    if (ignoredPath) {
      this.#dependencies.logger.warn(
        `agent_system.manifest_shadowed selected=${quote(result.path ?? '')} ignored=${quote(ignoredPath)}`,
      );
    }

    if (result.status === 'invalid') {
      this.#dependencies.logger.error(
        `agent_system.manifest_invalid trigger=${quote(trigger)}${agentAttribute} path=${quote(result.path ?? '')} codes=${quote(diagnosticCodes(result.diagnostics))}`,
      );
      return;
    }

    const event =
      previous?.status === 'loaded' && previous.digest !== result.digest
        ? 'manifest_changed'
        : 'manifest_loaded';
    this.#dependencies.logger.info(
      `agent_system.${event} trigger=${quote(trigger)}${agentAttribute} path=${quote(result.path)} schemaVersion=${result.manifest.schemaVersion} digest=${quote(result.digest)}`,
    );
  }
}
