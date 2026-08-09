import { Type } from 'typebox';

import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import type {
  AgentSystemAuthorizationDecision,
  AgentSystemCliToolDefinition,
  AgentSystemOperation,
} from '../lib/tool-types.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

export const toolTestWorkspaceDir = '/workspace/data';
export const toolTestManifest: AgentManifest = { schemaVersion: 1, agent: { id: 'data' } };
export const toolTestParameters = Type.Object(
  { argument: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export interface ToolTestConfiguration {
  token: string;
}

export type ToolTestDefinition = AgentSystemCliToolDefinition<
  typeof toolTestParameters,
  ToolTestConfiguration,
  ToolTestConfiguration,
  string
>;

export interface ToolTestDefinitionOptions {
  authorize?(
    operation: AgentSystemOperation,
    configuration: ToolTestConfiguration,
  ): AgentSystemAuthorizationDecision | Promise<AgentSystemAuthorizationDecision>;
  configured?: boolean;
  validate?(input: { argument: string }, configuration: ToolTestConfiguration): void;
}

export function loadedToolTestManifest(
  inputManifest = toolTestManifest,
): Extract<AgentManifestLoadResult, { status: 'loaded' }> {
  return {
    status: 'loaded',
    scope: { agentId: inputManifest.agent.id, workspaceDir: toolTestWorkspaceDir },
    path: `${toolTestWorkspaceDir}/agent.yaml`,
    digest: 'manifest-digest',
    manifest: inputManifest,
    diagnostics: [],
    validationChecks: [],
  };
}

export function createToolTestDefinition(
  options: ToolTestDefinitionOptions = {},
): ToolTestDefinition {
  return {
    apiVersion: 1,
    id: 'test-tool',
    authorization: {
      authorize: options.authorize ?? (() => ({ status: 'allowed' })),
      mode: 'agent-system',
      policyId: 'agent-system.test-tool',
    },
    commands: [{ command: 'test-tool' }],
    configuration: {
      read: () => (options.configured === false ? undefined : { token: 'AGENT_TOKEN' }),
      resolve: (configuration) => configuration,
    },
    guidance: { prompt: 'Use the Agent System test tool.' },
    runner: {
      argv: (input) => [input.argument],
      credentialBindings: (configuration) => ({ TOOL_TOKEN: configuration.token }),
      executable: 'test-tool',
    },
    tool: {
      classify: () => ({ action: 'inspect', risk: 'read', summary: 'Inspect test data.' }),
      description: 'Exercise the generic Agent System tool runtime.',
      inputFromCommand: ([argument = 'status']) => ({ argument }),
      label: 'Test tool',
      name: 'agent_system_test_tool',
      normalize: (result) => result.stdout,
      parameters: toolTestParameters,
      ...(options.validate ? { validate: options.validate } : {}),
    },
  };
}
