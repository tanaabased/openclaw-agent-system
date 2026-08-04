import { definePluginEntry, type OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';

import AgentManifestService from './lib/agent-manifest-service.ts';
import registerAgentSystemCli from './lib/register-cli.ts';
import registerAgentSystemHooks from './lib/register-hooks.ts';

export default definePluginEntry({
  id: 'agent-system',
  name: 'Agent System',
  description:
    'Define reproducible identity, environment, and installation for OpenClaw agent workspaces.',
  register(api) {
    const manifestService = new AgentManifestService({
      getConfig: () => api.runtime.config.current(),
      logger: api.logger,
      parseSessionAgentId(sessionKey) {
        return parseAgentSessionKey(sessionKey)?.agentId;
      },
      resolveAgentWorkspaceDir(config, agentId) {
        return api.runtime.agent.resolveAgentWorkspaceDir(config as OpenClawConfig, agentId);
      },
    });

    registerAgentSystemHooks(api, manifestService);
    api.registerCli(
      ({ program }) => {
        registerAgentSystemCli(program, { manifestService });
      },
      {
        commands: ['agent-system', 'as'],
        descriptors: [
          {
            name: 'agent-system',
            description: 'Manage reproducible OpenClaw agent workspaces.',
            hasSubcommands: true,
          },
          {
            name: 'as',
            description: 'Alias for the Agent System command.',
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
