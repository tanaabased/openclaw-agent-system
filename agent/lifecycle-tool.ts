import type { TSchema } from 'typebox';

import type AgentLifecycleApproval from './lifecycle-approval.ts';
import type { LifecycleToolName } from './lifecycle-tool-contract.ts';
import type { RegisteredAgentSystemTool } from '../api/types.ts';
import AgentSystemToolError from '../api/error.ts';

/** Native lifecycle tools share approval execution, never a command or credential route. */
export default function createLifecycleTool(
  definition: {
    id: string;
    name: LifecycleToolName;
    label: string;
    description: string;
    parameters: TSchema;
    guidance: string;
  },
  approval: () => AgentLifecycleApproval,
): RegisteredAgentSystemTool {
  return {
    apiVersion: 1,
    id: definition.id,
    commands: [],
    toolNames: [definition.name],
    isConfigured: () => true,
    guidance: { prompt: definition.guidance },
    invoke() {
      throw new AgentSystemToolError(
        'approval_denied',
        'Lifecycle operations require a native tool call with OpenClaw chat approval.',
      );
    },
    registerTools(api) {
      // Keep this factory with its instance-local hooks; a name hint lets OpenClaw
      // substitute the Gateway tool without its captured caller or approval state.
      api.registerTool({
        contextVersion: 2,
        create: (context) => ({
          name: definition.name,
          label: definition.label,
          description: definition.description,
          parameters: definition.parameters,
          async execute(toolCallId, params, signal) {
            const output = await approval().execute(
              definition.name,
              params,
              toolCallId,
              context,
              signal,
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output) }],
              details: output,
            };
          },
        }),
      });
    },
  };
}
