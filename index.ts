import { buildJsonPluginConfigSchema, definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import pluginManifest from './openclaw.plugin.json' with { type: 'json' };

import agentSystemCliMetadata from './cli/metadata.ts';
import registerAgentSystem from './core/register-agent-system.ts';
import { agentSystemPluginIdentity } from './core/plugin-identity.ts';

export default definePluginEntry({
  ...agentSystemPluginIdentity,
  configSchema: buildJsonPluginConfigSchema(pluginManifest.configSchema),
  register(api) {
    if (api.registrationMode === 'cli-metadata') {
      api.registerCli(() => {}, agentSystemCliMetadata);
      return;
    }
    registerAgentSystem(api, import.meta.url);
  },
});
