import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentLifecycleApproval from '../agent/lifecycle-approval.ts';
import { lifecycleToolNames, type LifecycleToolName } from '../agent/lifecycle-tool-contract.ts';

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
