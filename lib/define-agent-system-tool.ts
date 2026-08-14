import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { AgentManifest } from '../utils/manifest-types.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type AgentSystemToolRuntime from './tool-runtime.ts';
import type {
  AgentSystemAuthorizationDecision,
  AgentSystemManifestValueResolver,
  AgentSystemOperation,
  AgentSystemToolCommand,
  AgentSystemToolExecutionResult,
  AgentSystemToolGuidance,
  AgentSystemToolScope,
  RegisteredAgentSystemTool,
} from './tool-types.ts';

interface ToolDefinition<TParameters extends TSchema, TDeclaredConfiguration> {
  apiVersion: 1;
  authorization?: {
    authorize?(
      operation: AgentSystemOperation,
      configuration: TDeclaredConfiguration,
    ): AgentSystemAuthorizationDecision | Promise<AgentSystemAuthorizationDecision>;
    policyId?: string;
  };
  commands?: AgentSystemToolCommand[];
  configuration: {
    read(manifest: AgentManifest): TDeclaredConfiguration | undefined;
    resolve(
      configuration: TDeclaredConfiguration,
      resolver: AgentSystemManifestValueResolver,
    ): unknown;
  };
  guidance?: AgentSystemToolGuidance;
  id: string;
  tool: {
    classify(
      input: Static<TParameters>,
      configuration: TDeclaredConfiguration,
    ): AgentSystemOperation;
    description: string;
    inputFromCommand(argv: string[], stdin?: string): Static<TParameters>;
    label: string;
    name: string;
    parameters: TParameters;
    validate?(input: Static<TParameters>, configuration: TDeclaredConfiguration): void;
  };
}

type ExecuteTool<TParameters extends TSchema> = (
  runtime: AgentSystemToolRuntime,
  input: Static<TParameters>,
  scope: AgentSystemToolScope,
  signal?: AbortSignal,
) => Promise<AgentSystemToolExecutionResult>;

function toolResult(output: unknown, auditId: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    details: { auditId, output },
  };
}

/** Compile one static Agent System definition into native, command, and policy surfaces. */
export default function defineAgentSystemTool<TParameters extends TSchema, TDeclaredConfiguration>(
  definition: ToolDefinition<TParameters, TDeclaredConfiguration>,
  execute: ExecuteTool<TParameters>,
): RegisteredAgentSystemTool {
  const factory =
    (runtime: AgentSystemToolRuntime): OpenClawPluginToolFactory =>
    (toolContext) => ({
      name: definition.tool.name,
      label: definition.tool.label,
      description: definition.tool.description,
      parameters: definition.tool.parameters,
      async execute(toolCallId, input: Static<TParameters>, signal) {
        const result = await execute(
          runtime,
          input,
          { source: 'tool', toolCallId, toolContext },
          signal,
        );
        return toolResult(result.output, result.auditId);
      },
    });

  const registerTrustedPolicy =
    definition.authorization?.authorize && definition.authorization.policyId
      ? (
          api: Parameters<NonNullable<RegisteredAgentSystemTool['registerTrustedPolicy']>>[0],
          manifestService: Pick<AgentManifestService, 'loadForAgentId'>,
        ) => {
          api.registerTrustedToolPolicy({
            id: definition.authorization?.policyId ?? definition.id,
            description: `Apply Agent System policy to ${definition.tool.name}.`,
            async evaluate(event, context) {
              if (event.toolName !== definition.tool.name) return undefined;
              const agentId = context.agentId?.trim();
              if (!agentId) {
                return { allow: false, reason: 'Agent System could not resolve the active agent.' };
              }
              const loaded = await manifestService.loadForAgentId(agentId, 'before_tool_call');
              if (loaded.status !== 'loaded') {
                return {
                  allow: false,
                  reason: 'Agent System could not load the active agent manifest for policy.',
                };
              }
              const configuration = definition.configuration.read(loaded.manifest);
              if (configuration === undefined) {
                return {
                  allow: false,
                  reason: `Agent ${agentId} does not configure the ${definition.id} tool.`,
                };
              }
              if (!Value.Check(definition.tool.parameters, event.params)) {
                return { allow: false, reason: `The ${definition.tool.name} request is invalid.` };
              }
              const input = event.params as Static<TParameters>;
              try {
                definition.tool.validate?.(input, configuration);
              } catch {
                return { allow: false, reason: `The ${definition.tool.name} request is invalid.` };
              }
              const operation = definition.tool.classify(input, configuration);
              const decision = await definition.authorization?.authorize?.(
                operation,
                configuration,
              );
              if (!decision || decision.status === 'allowed') return undefined;
              return { allow: false, reason: decision.reason };
            },
          });
        }
      : undefined;

  return {
    apiVersion: definition.apiVersion,
    commands: definition.commands ?? [],
    ...(definition.guidance ? { guidance: definition.guidance } : {}),
    id: definition.id,
    isConfigured: (manifest) => definition.configuration.read(manifest) !== undefined,
    invoke(runtime, argv, scope, stdin) {
      return execute(runtime, definition.tool.inputFromCommand(argv, stdin), scope);
    },
    registerTools(api, runtime) {
      api.registerTool(factory(runtime), { name: definition.tool.name });
    },
    ...(registerTrustedPolicy ? { registerTrustedPolicy } : {}),
    toolNames: [definition.tool.name],
  };
}
