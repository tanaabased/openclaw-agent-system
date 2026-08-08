import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import type { Static, TSchema } from 'typebox';

import type AgentSystemToolRuntime from './tool-runtime.ts';
import type { AgentSystemCliToolDefinition, RegisteredAgentSystemTool } from './tool-types.ts';

function toolResult(output: unknown, auditId: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    details: { auditId, output },
  };
}

/** Compile one command-backed definition into native and CLI tool surfaces. */
export default function defineAgentSystemCliTool<
  TParameters extends TSchema,
  TDeclaredConfiguration,
  TResolvedConfiguration,
  TOutput,
>(
  definition: AgentSystemCliToolDefinition<
    TParameters,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    TOutput
  >,
): RegisteredAgentSystemTool {
  const factory =
    (runtime: AgentSystemToolRuntime): OpenClawPluginToolFactory =>
    (toolContext) => ({
      name: definition.tool.name,
      label: definition.tool.label,
      description: definition.tool.description,
      parameters: definition.tool.parameters,
      async execute(_toolCallId, input: Static<TParameters>, signal) {
        const result = await runtime.executeCli(
          definition,
          input,
          { source: 'tool', toolContext },
          signal,
        );
        return toolResult(result.output, result.auditId);
      },
    });

  return {
    apiVersion: definition.apiVersion,
    commands: definition.commands ?? [],
    ...(definition.guidance ? { guidance: definition.guidance } : {}),
    id: definition.id,
    isConfigured: (manifest) => definition.configuration.read(manifest) !== undefined,
    async invoke(runtime, argv, scope) {
      return runtime.executeCli(definition, definition.tool.inputFromCommand(argv), scope);
    },
    registerTools(api, runtime) {
      api.registerTool(factory(runtime), { name: definition.tool.name });
    },
    toolNames: [definition.tool.name],
  };
}
