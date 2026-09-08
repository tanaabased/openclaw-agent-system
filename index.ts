import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import registerAgentSystem from './core/register-agent-system.ts';
import { agentSystemPluginIdentity } from './core/plugin-identity.ts';

export default definePluginEntry({
  ...agentSystemPluginIdentity,
  register(api) {
    // Root command metadata is declared in openclaw.plugin.json. OpenClaw 2026.9.3
    // intentionally withholds api.runtime while collecting that metadata.
    if (api.registrationMode === 'cli-metadata') return;
    registerAgentSystem(api, import.meta.url);
  },
});
