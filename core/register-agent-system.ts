import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listAgentIds } from 'openclaw/plugin-sdk/agent-scope-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { getGlobalHookRunner } from 'openclaw/plugin-sdk/plugin-runtime';
import { runPluginCommandWithTimeout } from 'openclaw/plugin-sdk/run-command';

import createGitHubNotificationRuntime from '../channels/github/runtime/create-runtime.ts';
import createGitCapability from '../tools/git/capability.ts';
import createGitHubCapability from '../tools/github/capability.ts';
import resolveCodexCommandAgentId from '../agent/resolve-codex-command-id.ts';
import registerAgentCommandSecurity from '../agent/command-security.ts';
import AgentCommandAuthority from '../agent/command-authority.ts';
import AgentDoctorService from '../agent/doctor-service.ts';
import AgentEnvironmentService from '../environment/service.ts';
import AgentInstallService from '../agent/install-service.ts';
import createAgentLifecycleContribution from '../agent/lifecycle.ts';
import createModelLifecycleContribution from '../agent/model-lifecycle.ts';
import AgentManifestService, { type ManifestLoadTrigger } from '../manifest/service.ts';
import AgentPathService from '../paths/service.ts';
import CodexPathConfigService from '../paths/codex-config-service.ts';
import createCredentialStores from '../credentials/registry.ts';
import { resolveFileCredentialStoreRoot } from '../credentials/file-store.ts';
import AgentSystemLifecycleRegistry from './lifecycle-registry.ts';
import { createAgentSystemLifecycleLogger, createAgentSystemLogger } from './logger.ts';
import OpCredentialInput from '../credentials/op-input.ts';
import OpCredentialManager from '../credentials/op-manager.ts';
import OpCredentialService from '../credentials/op-service.ts';
import OpEnvironmentService from '../environment/op-service.ts';
import processOpCache from '../environment/op-process-cache.ts';
import createPathLifecycleContribution from '../paths/lifecycle.ts';
import PathProjectionStore from '../paths/projection-store.ts';
import registerAgentSystemCli from '../cli/register.ts';
import agentSystemCliMetadata from '../cli/metadata.ts';
import registerAgentCommandAuthority from './register-agent-command-authority.ts';
import registerAgentSystemHooks from './register-hooks.ts';
import AgentSystemToolRegistry from '../api/registry.ts';
import AgentSystemToolRuntime from '../api/runtime.ts';
import createToolCliRunner from '../api/cli-runner.ts';
import createToolAccessLifecycleContribution from '../api/access-lifecycle.ts';
import createAgentToolAccessGrants from '../api/tool-access-grants.ts';
import createToolSecurityLifecycleContribution from '../api/security-lifecycle.ts';
import WorkspaceGitignoreService from '../paths/workspace-gitignore-service.ts';
import ConversationHookAccess, {
  inspectConversationHookPolicy,
  inspectRunningConversationHook,
  requiredConversationHooks,
} from './conversation-hook-access.ts';
import readFreshRuntimeConfig from './read-fresh-runtime-config.ts';
import registerOpCache from './register-op-cache.ts';
import { requestOpCacheGateway } from '../cli/credentials-cache.ts';

function parseModelCatalogRows(stdout: string) {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(Reflect.get(parsed, 'models'))) {
    throw new Error('OpenClaw models list returned an invalid JSON result.');
  }
  return Reflect.get(parsed, 'models').map((value: unknown) => {
    if (!value || typeof value !== 'object') {
      throw new Error('OpenClaw models list returned an invalid model row.');
    }
    const key = Reflect.get(value, 'key');
    const missing = Reflect.get(value, 'missing');
    if (typeof key !== 'string' || typeof missing !== 'boolean') {
      throw new Error('OpenClaw models list returned an invalid model row.');
    }
    return { key, missing };
  });
}

/** Assemble and register the complete Agent System runtime. */
export default function registerAgentSystem(api: OpenClawPluginApi, runtimeUrl: string): void {
  const runtimeDir = dirname(fileURLToPath(runtimeUrl));
  const packageDir = basename(runtimeDir) === 'dist' ? dirname(runtimeDir) : runtimeDir;
  const logger = createAgentSystemLogger(api.logger, api.id);
  const lifecycleLogger = createAgentSystemLifecycleLogger(api.logger, api.id, {
    getChildLogger(bindings) {
      return api.runtime.logging.getChildLogger(bindings);
    },
  });
  const privateStateRoot = resolveFileCredentialStoreRoot(process.env);
  const readConfig = readFreshRuntimeConfig;
  const readRuntimeConfig = () => api.runtime.config.current() as OpenClawConfig;
  const cliEntry = process.argv[1] ? resolve(process.argv[1]) : undefined;
  const openClawCommand = cliEntry ? [process.execPath, cliEntry] : ['openclaw'];
  const toolLauncherDirectory = process.env.AGENT_SYSTEM_TOOL_LAUNCHER_DIR?.trim();
  const excludedToolExecutableDirectories = [
    join(packageDir, 'bin'),
    ...(toolLauncherDirectory ? [toolLauncherDirectory] : []),
  ];
  const currentUid = process.getuid?.();
  const credentialStores = createCredentialStores({
    currentUid,
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
  const opCache = processOpCache({
    packageDir,
    stateDir: api.runtime.state.resolveStateDir(),
    credentialRoot: privateStateRoot,
  });
  const opEnvironmentService = new OpEnvironmentService({
    cache: opCache,
    credentialService: opCredentialService,
    integrationVersion: api.version ?? 'dev',
    readCachePolicy() {
      const config = readRuntimeConfig();
      const pluginConfig = config.plugins?.entries?.['agent-system']?.config;
      opCache.configureContext([config.agents, pluginConfig]);
      return pluginConfig?.opCache;
    },
  });
  registerOpCache(api, opEnvironmentService);
  const credentialManager = new OpCredentialManager({
    credentialService: opCredentialService,
    environmentService: opEnvironmentService,
    async invalidate(agentId) {
      opEnvironmentService.flush(agentId);
      try {
        await requestOpCacheGateway('flush', agentId);
        return 'confirmed';
      } catch {
        return 'pending';
      }
    },
  });
  const gitignoreService = new WorkspaceGitignoreService();
  const pathService = new AgentPathService({
    basePath: process.env.PATH ?? '',
    codexConfigService: new CodexPathConfigService({ gitignoreService }),
    mutateConfigFile(params) {
      return api.runtime.config.mutateConfigFile(params);
    },
    packageDir,
    projectionStore: new PathProjectionStore({
      ...(currentUid === undefined ? {} : { currentUid }),
      ...(privateStateRoot === undefined ? {} : { rootDir: privateStateRoot }),
    }),
    readConfig,
  });

  // Agent inspection and reconciliation run only after synchronous plugin registration completes.
  const environmentServiceRef: { current?: AgentEnvironmentService } = {};
  const manifestServiceRef: { current?: AgentManifestService } = {};
  const lifecycleEnvironmentService = {
    invalidateCredentials(agentId: string) {
      opEnvironmentService.flush(agentId);
    },
    loadForAgentId(agentId: string, trigger?: ManifestLoadTrigger) {
      const service = environmentServiceRef.current;
      if (!service) throw new Error('Agent System environment service is unavailable.');
      return service.loadForAgentId(agentId, trigger);
    },
    loadForWorkspace(
      workspaceDir: string,
      expectedAgentId?: string,
      trigger?: ManifestLoadTrigger,
    ) {
      const service = environmentServiceRef.current;
      if (!service) throw new Error('Agent System environment service is unavailable.');
      return service.loadForWorkspace(workspaceDir, expectedAgentId, trigger);
    },
  };
  const lifecycleManifestService = {
    loadForAgentId(agentId: string, trigger?: ManifestLoadTrigger) {
      const service = manifestServiceRef.current;
      if (!service) throw new Error('Agent System manifest service is unavailable.');
      return service.loadForAgentId(agentId, trigger);
    },
  };
  const runCli = createToolCliRunner((argv, options) =>
    api.runtime.system.runCommandWithTimeout(argv, options),
  );
  const capabilityDependencies = {
    runCli,
    baseEnvironment: process.env,
    ...(currentUid === undefined ? {} : { currentUid }),
    excludedExecutableDirectories: excludedToolExecutableDirectories,
    ...(process.env.HOME ? { homeDirectory: process.env.HOME } : {}),
  };
  const gitCapability = createGitCapability({
    ...capabilityDependencies,
    environmentService: lifecycleEnvironmentService,
    gitignoreService,
    manifestService: lifecycleManifestService,
    packageDir,
  });
  const githubCapability = createGitHubCapability({
    ...capabilityDependencies,
    environmentService: lifecycleEnvironmentService,
    mutateConfigFile(params) {
      return api.runtime.config.mutateConfigFile(params);
    },
    openClawStateDir: api.runtime.state.resolveStateDir(),
    privateStateRoot,
    readConfig,
  });
  const registrationPolicy = inspectConversationHookPolicy(api.config ?? {});
  const hookAccess = new ConversationHookAccess({
    readConfig,
    mutateConfigFile: (params) => api.runtime.config.mutateConfigFile(params),
    inspectPlugin(workspaceDir) {
      return runPluginCommandWithTimeout({
        argv: [...openClawCommand, 'plugins', 'inspect', 'agent-system', '--runtime', '--json'],
        cwd: workspaceDir,
        timeoutMs: 30_000,
      });
    },
  });
  const inspectRuntimeHook = () =>
    inspectRunningConversationHook({
      config: readRuntimeConfig(),
      registrationPolicy,
      hasRequiredHooks: requiredConversationHooks.every(
        (name) => getGlobalHookRunner()?.hasHooks(name) === true,
      ),
    });
  const notificationRuntime = createGitHubNotificationRuntime({
    hookAccess,
    inspectRuntimeHook,
    accountClient: githubCapability.accountClient,
    ...(currentUid === undefined ? {} : { currentUid }),
    dispatchChannelInboundTurn: api.runtime.channel.inbound.dispatch,
    lifecycleLogger,
    mutateConfigFile(params) {
      return api.runtime.config.mutateConfigFile(params);
    },
    ...(privateStateRoot === undefined ? {} : { privateStateRoot }),
    readConfig,
    readRuntimeConfig,
    replyToolLogger: logger,
    resolveAgentWorkspaceDir(config, agentId) {
      return api.runtime.agent.resolveAgentWorkspaceDir(config, agentId);
    },
    sessionRuntime: api.runtime.agent.session,
    worktrees: gitCapability.trustedWorktreeService,
  });
  api.on('after_tool_call', (event, context) =>
    notificationRuntime.sessionSetup.observe(event, context),
  );
  const toolRegistry = new AgentSystemToolRegistry([
    ...gitCapability.tools,
    ...githubCapability.tools,
    notificationRuntime.replyTool,
  ]);
  const lifecycleRegistry = new AgentSystemLifecycleRegistry([
    createAgentLifecycleContribution({
      environmentService: lifecycleEnvironmentService,
      readConfig,
      resolveAgentWorkspaceDir(config, agentId) {
        return api.runtime.agent.resolveAgentWorkspaceDir(config, agentId);
      },
      runOpenClawCommand(args, cwd) {
        const argv = [...openClawCommand, ...args];
        return runPluginCommandWithTimeout({ argv, cwd, timeoutMs: 120_000 });
      },
    }),
    createModelLifecycleContribution({
      async inspectConfiguredModels({ agentId, workspaceDir }) {
        const result = await runPluginCommandWithTimeout({
          argv: [...openClawCommand, 'models', 'list', '--agent', agentId, '--json'],
          cwd: workspaceDir,
          timeoutMs: 120_000,
        });
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || `OpenClaw models list exited ${result.code}.`);
        }
        return parseModelCatalogRows(result.stdout);
      },
      mutateConfigFile(params) {
        return api.runtime.config.mutateConfigFile(params);
      },
      readConfig,
      resolveCliBackendDispatchEligibility(params) {
        return api.runtime.agent.resolveCliBackendDispatchEligibility({
          agentId: params.agentId,
          config: params.config,
          model: params.model,
          provider: params.provider,
          workspaceDir: params.workspaceDir,
        });
      },
      resolveDefaultModelForAgent({ agentId, config }) {
        return api.runtime.modelConfig.resolveDefaultModelForAgent({
          agentId,
          cfg: config,
        });
      },
      resolveThinkingPolicy(params) {
        return api.runtime.agent.resolveThinkingPolicy(params);
      },
    }),
    createToolAccessLifecycleContribution({
      readConfig,
      mutateConfigFile(params) {
        return api.runtime.config.mutateConfigFile(params);
      },
      toolGrants(manifest) {
        return createAgentToolAccessGrants(toolRegistry, manifest);
      },
    }),
    createToolSecurityLifecycleContribution({ readConfig }),
    createPathLifecycleContribution({ pathService }),
    ...gitCapability.lifecycleContributions,
    ...githubCapability.lifecycleContributions,
    notificationRuntime.lifecycleContribution,
  ]);
  const manifestService = new AgentManifestService({
    getConfig: () => api.runtime.config.current(),
    logger: lifecycleLogger,
    parseSessionAgentId(sessionKey) {
      return parseAgentSessionKey(sessionKey)?.agentId;
    },
    resolveAgentWorkspaceDir(config, agentId) {
      return api.runtime.agent.resolveAgentWorkspaceDir(config as OpenClawConfig, agentId);
    },
    validateManifest(manifest, workspaceDir) {
      return lifecycleRegistry.validate({ manifest, workspaceDir });
    },
  });
  manifestServiceRef.current = manifestService;
  const environmentService = new AgentEnvironmentService({
    hostEnvironment: process.env,
    logger: lifecycleLogger,
    manifestService,
    opEnvironmentService,
  });
  environmentServiceRef.current = environmentService;
  const commandAuthority = new AgentCommandAuthority({
    ...(currentUid === undefined ? {} : { currentUid }),
    manifestService,
    async resolveCodexAgentId({ codexHome, openClawStateDir }) {
      const config = api.runtime.config.current() as OpenClawConfig;
      return resolveCodexCommandAgentId({
        agentIds: listAgentIds(config),
        codexHome,
        ...(openClawStateDir === undefined ? {} : { openClawStateDir }),
        resolveAgentDir: (agentId) => api.runtime.agent.resolveAgentDir(config, agentId),
        resolveStateDir: () => api.runtime.state.resolveStateDir(),
      });
    },
  });
  const doctorService = new AgentDoctorService({ lifecycleRegistry });
  const toolRuntime = new AgentSystemToolRuntime({
    runCli,
    baseEnvironment: process.env,
    environmentService,
    excludedExecutableDirectories: excludedToolExecutableDirectories,
    logger: lifecycleLogger,
    manifestService,
  });
  const installService = new AgentInstallService({
    credentialManager,
    lifecycleRegistry,
  });
  const {
    channel: notificationChannel,
    monitorService: notificationMonitorService,
    statusService: notificationStatusService,
  } = notificationRuntime.assemble(manifestService, {
    async execute(input) {
      const result = await toolRuntime.executeCli(
        gitCapability.definition,
        {
          argv: input.argv,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        },
        {
          agentId: input.agentId,
          source: 'command',
          workspaceDir: input.workspaceDir,
        },
        input.signal,
      );
      return result.commandResult;
    },
  });

  api.registerChannel({
    plugin: notificationChannel,
  });
  toolRegistry.registerTools(api, toolRuntime);
  toolRegistry.registerTrustedPolicies(api, manifestService);
  registerAgentCommandAuthority(api, {
    authority: commandAuthority,
    logger,
    manifestService,
  });
  registerAgentCommandSecurity(api, {
    logger,
    managedExecutableDirectories: excludedToolExecutableDirectories,
    manifestService,
  });
  registerAgentSystemHooks(api, manifestService, toolRegistry, notificationRuntime.promptGuidance);
  api.registerCli(({ program }) => {
    registerAgentSystemCli(program, {
      commandAuthority,
      credentialInput: opCredentialInput,
      credentialManager,
      doctorService,
      environmentService,
      input: process.stdin,
      installService,
      manifestService,
      notificationMonitorService,
      notificationStatusService,
      toolRegistry,
      toolRuntime,
    });
  }, agentSystemCliMetadata);
}
