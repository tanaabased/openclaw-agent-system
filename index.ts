import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from 'openclaw/plugin-sdk/config-runtime';
import { definePluginEntry, type OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { runPluginCommandWithTimeout } from 'openclaw/plugin-sdk/run-command';

import AgentEnvironmentService from './lib/agent-environment-service.ts';
import AgentDoctorService from './lib/agent-doctor-service.ts';
import AgentInstallService from './lib/agent-install-service.ts';
import AgentPathService from './lib/agent-path-service.ts';
import AgentManifestService from './lib/agent-manifest-service.ts';
import createCredentialStores from './lib/credential-store-registry.ts';
import CodexPathConfigService from './lib/codex-path-config-service.ts';
import { resolveFileCredentialStoreRoot } from './lib/file-credential-store.ts';
import OpCredentialManager from './lib/op-credential-manager.ts';
import OpCredentialInput from './lib/op-credential-input.ts';
import OpCredentialService from './lib/op-credential-service.ts';
import OpEnvironmentService from './lib/op-environment-service.ts';
import PathProjectionStore from './lib/path-projection-store.ts';
import AgentSystemToolRegistry from './lib/tool-registry.ts';
import AgentSystemToolRuntime from './lib/tool-runtime.ts';
import { createAgentSystemLogger } from './lib/logger.ts';
import registerAgentSystemCli from './lib/register-cli.ts';
import registerAgentSystemHooks from './lib/register-hooks.ts';
import GitHubConfigStore from './tools/github/config-store.ts';
import { createGitHubTool } from './tools/github/tool.ts';

export default definePluginEntry({
  id: 'agent-system',
  name: 'Agent System',
  description:
    'Define reproducible identity, environment, and installation for OpenClaw agent workspaces.',
  register(api) {
    const runtimeDir = dirname(fileURLToPath(import.meta.url));
    const packageDir = basename(runtimeDir) === 'dist' ? dirname(runtimeDir) : runtimeDir;
    const logger = createAgentSystemLogger(api.logger, api.id);
    const manifestService = new AgentManifestService({
      getConfig: () => api.runtime.config.current(),
      logger,
      parseSessionAgentId(sessionKey) {
        return parseAgentSessionKey(sessionKey)?.agentId;
      },
      resolveAgentWorkspaceDir(config, agentId) {
        return api.runtime.agent.resolveAgentWorkspaceDir(config as OpenClawConfig, agentId);
      },
    });
    const credentialStores = createCredentialStores({
      currentUid: process.getuid?.(),
      environment: process.env,
      platform: process.platform,
    });
    const opCredentialService = new OpCredentialService({
      hostEnvironment: process.env,
      stores: credentialStores,
    });
    const opCredentialInput = new OpCredentialInput({
      hostEnvironment: process.env,
      input: process.stdin,
      output: process.stderr,
    });
    const opEnvironmentService = new OpEnvironmentService({
      credentialService: opCredentialService,
      integrationVersion: api.version ?? 'dev',
    });
    const credentialManager = new OpCredentialManager({
      credentialService: opCredentialService,
      environmentService: opEnvironmentService,
    });
    const readConfig = () => {
      // Child OpenClaw commands mutate the config outside this process, so bypass its pinned snapshot.
      return loadConfig({ pin: false });
    };
    const privateStateRoot = resolveFileCredentialStoreRoot(process.env);
    const githubConfigStore = new GitHubConfigStore({
      currentUid: process.getuid?.(),
      rootDir: privateStateRoot,
    });
    const pathService = new AgentPathService({
      basePath: process.env.PATH ?? '',
      codexConfigService: new CodexPathConfigService(),
      mutateConfigFile(params) {
        return api.runtime.config.mutateConfigFile(params);
      },
      packageDir,
      projectionStore: new PathProjectionStore(privateStateRoot),
      readConfig,
    });
    const doctorService = new AgentDoctorService({ githubConfigStore, pathService });
    const environmentService = new AgentEnvironmentService({
      hostEnvironment: process.env,
      logger,
      manifestService,
      opEnvironmentService,
    });
    const toolRegistry = new AgentSystemToolRegistry([
      createGitHubTool({ configStore: githubConfigStore }),
    ]);
    const toolLauncherDirectory = process.env.AGENT_SYSTEM_TOOL_LAUNCHER_DIR?.trim();
    const toolRuntime = new AgentSystemToolRuntime({
      baseEnvironment: process.env,
      environmentService,
      excludedExecutableDirectories: [
        join(packageDir, 'bin'),
        ...(toolLauncherDirectory ? [toolLauncherDirectory] : []),
      ],
      logger,
      manifestService,
    });
    const cliEntry = process.argv[1] ? resolve(process.argv[1]) : undefined;
    const openClawCommand = cliEntry ? [process.execPath, cliEntry] : ['openclaw'];
    const installService = new AgentInstallService({
      credentialManager,
      environmentService,
      githubConfigStore,
      pathService,
      readConfig,
      runOpenClawCommand(args, cwd) {
        const argv = [...openClawCommand, ...args];
        return runPluginCommandWithTimeout({ argv, cwd, timeoutMs: 120_000 });
      },
    });
    toolRegistry.registerTools(api, toolRuntime);
    registerAgentSystemHooks(api, manifestService, toolRegistry);
    api.registerCli(
      ({ logger: cliLogger, program }) => {
        registerAgentSystemCli(program, {
          credentialInput: opCredentialInput,
          credentialManager,
          doctorService,
          environmentService,
          installService,
          logger: createAgentSystemLogger(cliLogger, api.id),
          manifestService,
          toolRegistry,
          toolRuntime,
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
