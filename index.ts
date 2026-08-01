import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import registerAgentSystemCli from './lib/register-cli.ts';

export default definePluginEntry({
  id: 'agent-system',
  name: 'Agent System',
  description:
    'Define reproducible identity, environment, and installation for OpenClaw agent workspaces.',
  register(api) {
    api.registerCli(
      ({ program }) => {
        registerAgentSystemCli(program);
      },
      {
        commands: ['agent-system', 'as'],
        descriptors: [
          {
            name: 'agent-system',
            description: 'Manage reproducible OpenClaw agent workspaces.',
            hasSubcommands: false,
          },
          {
            name: 'as',
            description: 'Alias for the Agent System command.',
            hasSubcommands: false,
          },
        ],
      },
    );
  },
});
