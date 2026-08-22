import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import registerAgentSystem from './core/register-agent-system.ts';
import { agentSystemPluginIdentity } from './core/plugin-identity.ts';

export default definePluginEntry({
  ...agentSystemPluginIdentity,
  register(api) {
    registerAgentSystem(api, import.meta.url);
  },
});
