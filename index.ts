import { loadConfig } from 'openclaw/plugin-sdk/config-runtime';
import { definePluginEntry, type OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { runPluginCommandWithTimeout } from 'openclaw/plugin-sdk/run-command';

import AgentEnvironmentService from './lib/agent-environment-service.ts';
import AgentInstallService from './lib/agent-install-service.ts';
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
    const installService = new AgentInstallService({
      readConfig() {
        // Child OpenClaw commands mutate the config outside this process, so bypass its pinned snapshot.
        return loadConfig({ pin: false });
      },
      runOpenClawCommand(args, cwd) {
        const cliEntry = process.argv[1];
        const argv = cliEntry ? [process.execPath, cliEntry, ...args] : ['openclaw', ...args];
        return runPluginCommandWithTimeout({ argv, cwd, timeoutMs: 120_000 });
      },
    });
    const environmentService = new AgentEnvironmentService({
      hostEnvironment: process.env,
      logger: api.logger,
      manifestService,
    });
    registerAgentSystemHooks(api, manifestService);
    api.registerCli(
      ({ program }) => {
        registerAgentSystemCli(program, {
          environmentService,
          installService,
          manifestService,
        });
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
