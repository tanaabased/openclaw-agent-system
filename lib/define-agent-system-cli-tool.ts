import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type AgentManifestService from './agent-manifest-service.ts';
import type AgentSystemToolApprovalReceiptStore from './tool-approval-receipt-store.ts';
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
          { source: 'tool', toolCallId: _toolCallId, toolContext },
          signal,
        );
        return toolResult(result.output, result.auditId);
      },
    });

  const registerTrustedPolicy =
    definition.authorization?.mode === 'agent-system' &&
    definition.authorization.authorize &&
    definition.authorization.policyId
      ? (
          api: Parameters<NonNullable<RegisteredAgentSystemTool['registerTrustedPolicy']>>[0],
          manifestService: Pick<AgentManifestService, 'loadForAgentId'>,
          approvals: Pick<AgentSystemToolApprovalReceiptStore, 'record'>,
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
              if (decision.status === 'denied') {
                return { allow: false, reason: decision.reason };
              }
              const toolCallId = context.toolCallId?.trim();
              if (!toolCallId) {
                return {
                  allow: false,
                  reason: 'OpenClaw did not provide a tool-call id for Agent System approval.',
                };
              }
              return {
                requireApproval: {
                  ...decision.request,
                  allowedDecisions: ['allow-once', 'deny'],
                  onResolution(resolution) {
                    if (resolution !== 'allow-once' && resolution !== 'allow-always') return;
                    approvals.record({ agentId, input, toolCallId, toolId: definition.id });
                  },
                  timeoutBehavior: 'deny',
                  timeoutReason: decision.reason,
                },
              };
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
    async invoke(runtime, argv, scope) {
      return runtime.executeCli(definition, definition.tool.inputFromCommand(argv), scope);
    },
    registerTools(api, runtime) {
      api.registerTool(factory(runtime), { name: definition.tool.name });
    },
    ...(registerTrustedPolicy ? { registerTrustedPolicy } : {}),
    toolNames: [definition.tool.name],
  };
}
