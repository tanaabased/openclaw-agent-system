import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import registerAgentSystem from './lib/register-agent-system.ts';
import { agentSystemPluginIdentity } from './utils/plugin-identity.ts';

export default definePluginEntry({
  ...agentSystemPluginIdentity,
  register(api) {
    registerAgentSystem(api, import.meta.url);
  },
});
