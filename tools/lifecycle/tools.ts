import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentLifecycleApproval from '../../agent/lifecycle-approval.ts';
import type { RegisteredAgentSystemTool } from '../../api/types.ts';
import AgentSystemToolError from '../../api/error.ts';
import { lifecycleParameters, lifecycleToolNames, type LifecycleToolName } from './schema.ts';

export function registerLifecycleApprovalHook(
  api: Pick<OpenClawPluginApi, 'on'>,
  approval: AgentLifecycleApproval,
): void {
  api.on(
    'before_tool_call',
    async (event, context) => {
      if (!lifecycleToolNames.includes(event.toolName as LifecycleToolName)) return;
      try {
        return await approval.request(event.toolName as LifecycleToolName, event.params, {
          ...context,
          toolCallId: context.toolCallId ?? event.toolCallId,
        });
      } catch {
        return {
          block: true,
          blockReason:
            'Agent System could not prepare this lifecycle approval for the active agent.',
        };
      }
    },
    { priority: 100 },
  );
}

/** Native tools deliberately have no command route or generic credential-resolving runtime. */
export default function createLifecycleTools(
  approval: () => AgentLifecycleApproval,
): RegisteredAgentSystemTool {
  return {
    apiVersion: 1,
    id: 'lifecycle',
    commands: [],
    toolNames: lifecycleToolNames,
    isConfigured: () => true,
    guidance: {
      prompt:
        'Use agent_system_install or agent_system_doctor for the active agent. OpenClaw must obtain Allow once in chat before execution, including Doctor checks. Never use shell commands or --yes to bypass approval. Doctor reports findings without repairs.',
    },
    invoke() {
      throw new AgentSystemToolError(
        'approval_denied',
        'Lifecycle operations require a native tool call with OpenClaw chat approval.',
      );
    },
    registerTools(api) {
      for (const name of lifecycleToolNames)
        api.registerTool(
          (context) => ({
            name,
            label: name === 'agent_system_install' ? 'Agent System Install' : 'Agent System Doctor',
            description:
              name === 'agent_system_install'
                ? 'Request chat approval, then reconcile the active agent workspace from its manifest, including setup. No agent or workspace override.'
                : 'Request chat approval, then inspect the active agent workspace and run manifest-defined checks. Does not apply repairs.',
            parameters: lifecycleParameters(name),
            async execute(toolCallId, params, signal) {
              const output = await approval().execute(name, params, toolCallId, context, signal);
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(output) }],
                details: {},
              };
            },
          }),
          { name },
        );
    },
  };
}
