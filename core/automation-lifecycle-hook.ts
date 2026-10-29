import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AutomationLifecycleAuthority from '../agent/automation-lifecycle-authority.ts';

export default function registerAutomationLifecycleHooks(
  api: Pick<OpenClawPluginApi, 'on'>,
  authority: AutomationLifecycleAuthority,
): void {
  api.on('before_agent_reply', (_event, context) => {
    authority.begin(context);
  });
  api.on('agent_end', (_event, context) => {
    authority.end(context.runId);
  });
}
