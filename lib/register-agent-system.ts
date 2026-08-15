import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from 'openclaw/plugin-sdk/config-runtime';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { runPluginCommandWithTimeout } from 'openclaw/plugin-sdk/run-command';

import { createGitHubNotificationChannel } from '../channels/github/channel.ts';
import GitHubNotificationActivationService from '../channels/github/lib/activation-service.ts';
import GitHubNotificationCommentService from '../channels/github/lib/comment-service.ts';
import GitHubNotificationAssignmentOrchestrator, {
  type GitHubNotificationAssignmentBoundaryInput,
} from '../channels/github/lib/assignment-orchestrator.ts';
import GitHubNotificationAssignmentProvider from '../channels/github/lib/assignment-provider.ts';
import createNotificationLifecycleContribution from '../channels/github/lib/lifecycle.ts';
import GitHubNotificationMonitorService from '../channels/github/lib/monitor-service.ts';
import GitHubNotificationMonitorCycleLeaseStore from '../channels/github/lib/monitor-cycle-lease.ts';
import GitHubNotificationStatusService from '../channels/github/lib/status-service.ts';
import { createGitHubNotificationMessageAdapter } from '../channels/github/lib/message-adapter.ts';
import GitHubNotificationMonitorStateStore from '../channels/github/lib/monitor-state-store.ts';
import GitHubNotificationPublicationService from '../channels/github/lib/publication-service.ts';
import registerGitHubNotificationProgressCommand from '../channels/github/lib/progress-command.ts';
import GitHubNotificationProgressService from '../channels/github/lib/progress-service.ts';
import NotificationRoutingReceiptStore from '../channels/github/lib/routing-receipt-store.ts';
import NotificationRoutingService from '../channels/github/lib/routing-service.ts';
import GitHubNotificationSessionService from '../channels/github/lib/session-service.ts';
import createGitCapability from '../tools/git/capability.ts';
import createGitHubCapability from '../tools/github/capability.ts';
import resolveCodexCommandAgentId from '../utils/resolve-codex-command-agent-id.ts';
import registerAgentCommandSecurity from './agent-command-security.ts';
import AgentCommandAuthority from './agent-command-authority.ts';
import AgentDoctorService from './agent-doctor-service.ts';
import AgentEnvironmentService from './agent-environment-service.ts';
import AgentInstallService from './agent-install-service.ts';
import createAgentLifecycleContribution from './agent-lifecycle.ts';
import AgentManifestService, { type ManifestLoadTrigger } from './agent-manifest-service.ts';
import AgentPathService from './agent-path-service.ts';
import CodexPathConfigService from './codex-path-config-service.ts';
import createCredentialStores from './credential-store-registry.ts';
import { resolveFileCredentialStoreRoot } from './file-credential-store.ts';
import AgentSystemLifecycleRegistry from './lifecycle-registry.ts';
import { createAgentSystemLifecycleLogger, createAgentSystemLogger } from './logger.ts';
import OpCredentialInput from './op-credential-input.ts';
import OpCredentialManager from './op-credential-manager.ts';
import OpCredentialService from './op-credential-service.ts';
import OpEnvironmentService from './op-environment-service.ts';
import createPathLifecycleContribution from './path-lifecycle.ts';
import PathProjectionStore from './path-projection-store.ts';
import registerAgentSystemCli from './register-cli.ts';
import registerAgentCommandAuthority from './register-agent-command-authority.ts';
import registerAgentSystemHooks from './register-hooks.ts';
import AgentSystemToolRegistry from './tool-registry.ts';
import AgentSystemToolRuntime from './tool-runtime.ts';
import createToolAccessLifecycleContribution from './tool-access-lifecycle.ts';
import createToolSecurityLifecycleContribution from './tool-security-lifecycle.ts';
import WorkspaceGitignoreService from './workspace-gitignore-service.ts';

/** Assemble and register the complete Agent System runtime. */
export default function registerAgentSystem(api: OpenClawPluginApi, runtimeUrl: string): void {
  const runtimeDir = dirname(fileURLToPath(runtimeUrl));
  const packageDir = basename(runtimeDir) === 'dist' ? dirname(runtimeDir) : runtimeDir;
  const logger = createAgentSystemLogger(api.logger, api.id);
  const lifecycleLogger = createAgentSystemLifecycleLogger(api.logger, api.id);
  const privateStateRoot = resolveFileCredentialStoreRoot(process.env);
  const readConfig = () => {
    // Child OpenClaw commands mutate the config outside this process, so bypass its pinned snapshot.
    return loadConfig({ pin: false });
  };
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
  const opEnvironmentService = new OpEnvironmentService({
    credentialService: opCredentialService,
    integrationVersion: api.version ?? 'dev',
  });
  const credentialManager = new OpCredentialManager({
    credentialService: opCredentialService,
    environmentService: opEnvironmentService,
  });
  const gitignoreService = new WorkspaceGitignoreService();
  const pathService = new AgentPathService({
    basePath: process.env.PATH ?? '',
    codexConfigService: new CodexPathConfigService({ gitignoreService }),
    mutateConfigFile(params) {
      return api.runtime.config.mutateConfigFile(params);
    },
    packageDir,
    projectionStore: new PathProjectionStore(privateStateRoot),
    readConfig,
  });

  // Agent inspection and reconciliation run only after synchronous plugin registration completes.
  const environmentServiceRef: { current?: AgentEnvironmentService } = {};
  const manifestServiceRef: { current?: AgentManifestService } = {};
  const lifecycleEnvironmentService = {
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
  const capabilityDependencies = {
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
    privateStateRoot,
  });
  const toolRegistry = new AgentSystemToolRegistry([
    ...gitCapability.tools,
    ...githubCapability.tools,
  ]);
  const notificationRoutingService = new NotificationRoutingService({
    mutateConfigFile(params) {
      return api.runtime.config.mutateConfigFile(params);
    },
    readConfig,
    receiptStore: new NotificationRoutingReceiptStore({
      ...(currentUid === undefined ? {} : { currentUid }),
      ...(privateStateRoot === undefined ? {} : { rootDir: privateStateRoot }),
    }),
  });
  const notificationMonitorStateStore = new GitHubNotificationMonitorStateStore({
    ...(currentUid === undefined ? {} : { currentUid }),
    ...(privateStateRoot === undefined ? {} : { rootDir: privateStateRoot }),
  });
  const notificationMonitorCycleLeaseStore = new GitHubNotificationMonitorCycleLeaseStore({
    ...(currentUid === undefined ? {} : { currentUid }),
    ...(privateStateRoot === undefined ? {} : { rootDir: privateStateRoot }),
  });
  const notificationMonitorServiceRef: { current?: GitHubNotificationMonitorService } = {};
  const lifecycleRegistry = new AgentSystemLifecycleRegistry([
    createAgentLifecycleContribution({
      environmentService: lifecycleEnvironmentService,
      readConfig,
      runOpenClawCommand(args, cwd) {
        const argv = [...openClawCommand, ...args];
        return runPluginCommandWithTimeout({ argv, cwd, timeoutMs: 120_000 });
      },
    }),
    createToolAccessLifecycleContribution({
      readConfig,
      mutateConfigFile(params) {
        return api.runtime.config.mutateConfigFile(params);
      },
      toolGrants(manifest) {
        return {
          desired: toolRegistry.configuredToolNames(manifest),
          owned: toolRegistry.allToolNames(),
        };
      },
    }),
    createToolSecurityLifecycleContribution({ readConfig }),
    createPathLifecycleContribution({ pathService }),
    ...gitCapability.lifecycleContributions,
    ...githubCapability.lifecycleContributions,
    createNotificationLifecycleContribution({
      monitorService: {
        runOnce(input) {
          const service = notificationMonitorServiceRef.current;
          if (!service) throw new Error('GitHub notification monitor service is unavailable.');
          return service.runOnce(input);
        },
      },
      routingService: notificationRoutingService,
      stateStore: notificationMonitorStateStore,
    }),
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
        agentIds: (config.agents?.list ?? []).map(({ id }) => id),
        codexHome,
        ...(openClawStateDir === undefined ? {} : { openClawStateDir }),
        resolveAgentDir: (agentId) => api.runtime.agent.resolveAgentDir(config, agentId),
        resolveStateDir: () => api.runtime.state.resolveStateDir(),
      });
    },
  });
  const doctorService = new AgentDoctorService({ lifecycleRegistry });
  const toolRuntime = new AgentSystemToolRuntime({
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
  const notificationAssignmentProvider = new GitHubNotificationAssignmentProvider({
    accountClient: githubCapability.accountClient,
    manifestService,
    readConfig: readRuntimeConfig,
  });
  const notificationPublicationService = new GitHubNotificationPublicationService();
  const notificationProgressService = new GitHubNotificationProgressService({
    leaseStore: notificationMonitorCycleLeaseStore,
    publicationService: notificationPublicationService,
    stateStore: notificationMonitorStateStore,
  });
  const notificationSessionService = new GitHubNotificationSessionService({
    dispatchReplyWithBufferedBlockDispatcher:
      api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    logger,
    publicationService: notificationPublicationService,
    readConfig: readRuntimeConfig,
    recordInboundSession: api.runtime.channel.session.recordInboundSession,
  });
  const trustedWorktreeInput = (input: GitHubNotificationAssignmentBoundaryInput) => ({
    agentId: input.agentId,
    cloneUrl: input.item.repositoryCloneUrl,
    defaultBranch: input.item.repositoryDefaultBranch,
    itemDatabaseId: input.item.itemDatabaseId,
    itemType: input.item.itemType,
    repositoryDatabaseId: input.item.repositoryDatabaseId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const notificationAssignmentOrchestrator = new GitHubNotificationAssignmentOrchestrator({
    authority: notificationAssignmentProvider,
    sessions: notificationSessionService,
    stateStore: notificationMonitorStateStore,
    worktrees: {
      inspect: (input) =>
        gitCapability.trustedWorktreeService.inspectGitHub(trustedWorktreeInput(input)),
      prepare: (input) =>
        gitCapability.trustedWorktreeService.prepareGitHub(trustedWorktreeInput(input)),
    },
  });
  const notificationMonitorService = new GitHubNotificationMonitorService({
    accountClient: githubCapability.accountClient,
    assignmentOrchestrator: notificationAssignmentOrchestrator,
    cycleLeaseStore: notificationMonitorCycleLeaseStore,
    logger,
    manifestService,
    readConfig: readRuntimeConfig,
    routingService: notificationRoutingService,
    stateStore: notificationMonitorStateStore,
  });
  const notificationActivationService = new GitHubNotificationActivationService({
    authority: notificationAssignmentProvider,
    leaseStore: notificationMonitorCycleLeaseStore,
    logger,
    sessions: notificationSessionService,
    stateStore: notificationMonitorStateStore,
  });
  const notificationCommentService = new GitHubNotificationCommentService({
    authority: notificationAssignmentProvider,
    leaseStore: notificationMonitorCycleLeaseStore,
    logger,
    sessions: notificationSessionService,
    stateStore: notificationMonitorStateStore,
  });
  const notificationStatusService = new GitHubNotificationStatusService({
    monitorService: notificationMonitorService,
    stateStore: notificationMonitorStateStore,
  });
  notificationMonitorServiceRef.current = notificationMonitorService;

  registerGitHubNotificationProgressCommand(api, {
    logger,
    progressService: notificationProgressService,
  });

  api.registerChannel({
    plugin: createGitHubNotificationChannel({
      activationService: notificationActivationService,
      commentService: notificationCommentService,
      message: createGitHubNotificationMessageAdapter({
        accountClient: githubCapability.accountClient,
        authority: notificationAssignmentProvider,
        leaseStore: notificationMonitorCycleLeaseStore,
        manifestService,
        stateStore: notificationMonitorStateStore,
      }),
      monitorService: notificationMonitorService,
      stateStore: notificationMonitorStateStore,
    }),
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
  registerAgentSystemHooks(api, manifestService, toolRegistry);
  api.registerCli(
    ({ logger: cliLogger, program }) => {
      registerAgentSystemCli(program, {
        commandAuthority,
        credentialInput: opCredentialInput,
        credentialManager,
        doctorService,
        environmentService,
        input: process.stdin,
        installService,
        logger: createAgentSystemLogger(cliLogger, api.id),
        manifestService,
        notificationMonitorService,
        notificationStatusService,
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
}
