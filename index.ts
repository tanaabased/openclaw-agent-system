import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import registerAgentSystem from './lib/register-agent-system.ts';

export default definePluginEntry({
  id: 'agent-system',
  name: 'Agent System',
  description:
    'Define reproducible identity, environment, and installation for OpenClaw agent workspaces.',
  register(api) {
    registerAgentSystem(api, import.meta.url);
  },
});
