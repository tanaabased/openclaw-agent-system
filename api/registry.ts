import { isAbsolute, join } from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type { AgentManifest } from '../manifest/types.ts';
import type AgentManifestService from '../manifest/service.ts';
import AgentSystemToolError from './error.ts';
import type AgentSystemToolRuntime from './runtime.ts';
import type {
  AgentSystemToolExecutionResult,
  AgentSystemToolScope,
  RegisteredAgentSystemTool,
} from './types.ts';

/** Own statically imported first-party tool definitions and their command routes. */
export default class AgentSystemToolRegistry {
  readonly #commands = new Map<string, RegisteredAgentSystemTool>();
  readonly #environmentVariables = new Map<
    string,
    { command: string; tool: RegisteredAgentSystemTool }
  >();
  readonly #tools = new Map<string, RegisteredAgentSystemTool>();

  constructor(tools: readonly RegisteredAgentSystemTool[]) {
    for (const tool of tools) {
      if (this.#tools.has(tool.id)) {
        throw new Error(`Duplicate Agent System tool id: ${tool.id}.`);
      }
      this.#tools.set(tool.id, tool);
      for (const { command, environmentVariable, hostFallback } of tool.commands) {
        if (!/^[a-z][a-z0-9-]{0,63}$/u.test(command)) {
          throw new Error(`Invalid Agent System tool command: ${command}.`);
        }
        if (hostFallback !== undefined && !/^[a-z][a-z0-9-]{0,63}$/u.test(hostFallback)) {
          throw new Error(`Invalid Agent System host executable for command: ${command}.`);
        }
        if (this.#commands.has(command)) {
          throw new Error(`Duplicate Agent System tool command: ${command}.`);
        }
        this.#commands.set(command, tool);
        const name = normalizeLauncherEnvironmentName(environmentVariable);
        if (reservedLauncherEnvironmentNames.has(name)) {
          throw new Error(`Reserved Agent System launcher environment variable: ${name}.`);
        }
        if (this.#environmentVariables.has(name)) {
          throw new Error(`Duplicate Agent System launcher environment variable: ${name}.`);
        }
        this.#environmentVariables.set(name, { command, tool });
      }
    }
  }

  /** Return strict launcher paths for command routes configured by one manifest. */
  launcherBindings(manifest: AgentManifest, launcherDirectory: string): Record<string, string> {
    if (!isAbsolute(launcherDirectory)) {
      throw new Error('Agent System launcher directory must be absolute.');
    }
    return Object.fromEntries(
      [...this.#environmentVariables.entries()]
        .filter(([, { tool }]) => tool.isConfigured(manifest))
        .map(([name, { command }]) => [name, join(launcherDirectory, `agent-system-${command}`)]),
    );
  }

  hostFallback(command: string): string | undefined {
    return this.#commands.get(command)?.commands.find((route) => route.command === command)
      ?.hostFallback;
  }

  /** Return the native model-facing tool names owned by every registered definition. */
  allToolNames(): string[] {
    return [...new Set([...this.#tools.values()].flatMap(({ toolNames }) => toolNames))];
  }

  /** Return the native model-facing tool names enabled by one agent manifest. */
  configuredToolNames(manifest: AgentManifest): string[] {
    return [
      ...new Set(
        [...this.#tools.values()].flatMap((tool) =>
          tool.isConfigured(manifest) ? tool.toolNames : [],
        ),
      ),
    ];
  }

  guidance(manifest: AgentManifest): string[] {
    return [...this.#tools.values()].flatMap((tool) =>
      tool.isConfigured(manifest) && tool.guidance ? [tool.guidance.prompt] : [],
    );
  }

  invoke(
    command: string,
    runtime: AgentSystemToolRuntime,
    argv: string[],
    scope: AgentSystemToolScope,
    stdin?: string,
    signal?: AbortSignal,
  ): Promise<AgentSystemToolExecutionResult> {
    const tool = this.#commands.get(command);
    if (!tool) {
      throw new AgentSystemToolError(
        'tool_unavailable',
        `Agent System tool command ${command} is unavailable.`,
      );
    }
    return tool.invoke(runtime, argv, scope, stdin, signal);
  }

  registerTools(
    api: Pick<OpenClawPluginApi, 'registerTool'>,
    runtime: AgentSystemToolRuntime,
  ): void {
    for (const tool of this.#tools.values()) tool.registerTools(api, runtime);
  }

  registerTrustedPolicies(
    api: Pick<OpenClawPluginApi, 'registerTrustedToolPolicy'>,
    manifestService: Pick<AgentManifestService, 'loadForAgentId'>,
  ): void {
    for (const tool of this.#tools.values()) {
      tool.registerTrustedPolicy?.(api, manifestService);
    }
  }
}

const reservedLauncherEnvironmentNames = new Set([
  'AGENT_SYSTEM_EXEC_AUTHORITY',
  'AGENT_SYSTEM_EXEC_CAPABILITY',
  'AGENT_SYSTEM_TOOL_LAUNCHER_DIR',
]);

function normalizeLauncherEnvironmentName(value: string): string {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (!normalized || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(normalized)) {
    throw new Error(`Invalid Agent System launcher environment variable: ${value}.`);
  }
  return normalized.startsWith('AGENT_SYSTEM_') ? normalized : `AGENT_SYSTEM_${normalized}`;
}
