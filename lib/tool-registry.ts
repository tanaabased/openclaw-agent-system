import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type { AgentManifest } from '../utils/manifest-types.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type AgentSystemToolApprovalReceiptStore from './tool-approval-receipt-store.ts';
import { AgentSystemToolError, type default as AgentSystemToolRuntime } from './tool-runtime.ts';
import type {
  AgentSystemToolExecutionResult,
  AgentSystemToolScope,
  RegisteredAgentSystemTool,
} from './tool-types.ts';

/** Own statically imported first-party tool definitions and their command routes. */
export default class AgentSystemToolRegistry {
  readonly #commands = new Map<string, RegisteredAgentSystemTool>();
  readonly #tools = new Map<string, RegisteredAgentSystemTool>();

  constructor(tools: readonly RegisteredAgentSystemTool[]) {
    for (const tool of tools) {
      if (this.#tools.has(tool.id)) {
        throw new Error(`Duplicate Agent System tool id: ${tool.id}.`);
      }
      this.#tools.set(tool.id, tool);
      for (const { command } of tool.commands) {
        if (this.#commands.has(command)) {
          throw new Error(`Duplicate Agent System tool command: ${command}.`);
        }
        this.#commands.set(command, tool);
      }
    }
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
  ): Promise<AgentSystemToolExecutionResult> {
    const tool = this.#commands.get(command);
    if (!tool) {
      throw new AgentSystemToolError(
        'tool_unavailable',
        `Agent System tool command ${command} is unavailable.`,
      );
    }
    return tool.invoke(runtime, argv, scope);
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
    approvals: Pick<AgentSystemToolApprovalReceiptStore, 'record'>,
  ): void {
    for (const tool of this.#tools.values()) {
      tool.registerTrustedPolicy?.(api, manifestService, approvals);
    }
  }
}
