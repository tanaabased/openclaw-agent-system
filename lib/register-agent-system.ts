import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from 'openclaw/plugin-sdk/config-runtime';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { runPluginCommandWithTimeout } from 'openclaw/plugin-sdk/run-command';

import { githubNotificationChannel } from '../channels/github/channel.ts';
import createNotificationLifecycleContribution from '../channels/github/lib/lifecycle.ts';
import NotificationRoutingReceiptStore from '../channels/github/lib/routing-receipt-store.ts';
import NotificationRoutingService from '../channels/github/lib/routing-service.ts';
import createGitCapability from '../tools/git/capability.ts';
import createGitHubCapability from '../tools/github/capability.ts';
import registerAgentCommandSecurity from './agent-command-security.ts';
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
import { createAgentSystemLogger } from './logger.ts';
import OpCredentialInput from './op-credential-input.ts';
import OpCredentialManager from './op-credential-manager.ts';
import OpCredentialService from './op-credential-service.ts';
import OpEnvironmentService from './op-environment-service.ts';
import createPathLifecycleContribution from './path-lifecycle.ts';
import PathProjectionStore from './path-projection-store.ts';
import registerAgentSystemCli from './register-cli.ts';
import registerAgentSystemHooks from './register-hooks.ts';
import AgentSystemToolApprovalReceiptStore from './tool-approval-receipt-store.ts';
import AgentSystemToolRegistry from './tool-registry.ts';
import AgentSystemToolRuntime from './tool-runtime.ts';
import createToolSecurityLifecycleContribution from './tool-security-lifecycle.ts';
import WorkspaceGitignoreService from './workspace-gitignore-service.ts';

/** Assemble and register the complete Agent System runtime. */
export default function registerAgentSystem(api: OpenClawPluginApi, runtimeUrl: string): void {
  const runtimeDir = dirname(fileURLToPath(runtimeUrl));
  const packageDir = basename(runtimeDir) === 'dist' ? dirname(runtimeDir) : runtimeDir;
  const logger = createAgentSystemLogger(api.logger, api.id);
  const privateStateRoot = resolveFileCredentialStoreRoot(process.env);
  const readConfig = () => {
    // Child OpenClaw commands mutate the config outside this process, so bypass its pinned snapshot.
    return loadConfig({ pin: false });
  };
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
  const lifecycleEnvironmentService = {
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
  const capabilityDependencies = {
    baseEnvironment: process.env,
    ...(currentUid === undefined ? {} : { currentUid }),
    excludedExecutableDirectories: excludedToolExecutableDirectories,
    ...(process.env.HOME ? { homeDirectory: process.env.HOME } : {}),
  };
  const gitCapability = createGitCapability({
    ...capabilityDependencies,
    gitignoreService,
    packageDir,
  });
  const githubCapability = createGitHubCapability({
    ...capabilityDependencies,
    environmentService: lifecycleEnvironmentService,
    privateStateRoot,
  });
  const notificationRoutingService = new NotificationRoutingService({
    mutateConfigFile(params) {
      return api.runtime.config.mutateConfigFile(params);
    },
    readConfig,
    receiptStore: new NotificationRoutingReceiptStore(privateStateRoot),
  });
  const lifecycleRegistry = new AgentSystemLifecycleRegistry([
    createAgentLifecycleContribution({
      environmentService: lifecycleEnvironmentService,
      readConfig,
      runOpenClawCommand(args, cwd) {
        const argv = [...openClawCommand, ...args];
        return runPluginCommandWithTimeout({ argv, cwd, timeoutMs: 120_000 });
      },
    }),
    createToolSecurityLifecycleContribution({ readConfig }),
    createPathLifecycleContribution({ pathService }),
    ...gitCapability.lifecycleContributions,
    ...githubCapability.lifecycleContributions,
    createNotificationLifecycleContribution({ routingService: notificationRoutingService }),
  ]);
  const manifestService = new AgentManifestService({
    getConfig: () => api.runtime.config.current(),
    logger,
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
  const environmentService = new AgentEnvironmentService({
    hostEnvironment: process.env,
    logger,
    manifestService,
    opEnvironmentService,
  });
  environmentServiceRef.current = environmentService;
  const doctorService = new AgentDoctorService({ lifecycleRegistry });
  const toolApprovals = new AgentSystemToolApprovalReceiptStore();
  const toolRegistry = new AgentSystemToolRegistry([
    ...gitCapability.tools,
    ...githubCapability.tools,
  ]);
  const toolRuntime = new AgentSystemToolRuntime({
    approvals: toolApprovals,
    baseEnvironment: process.env,
    environmentService,
    excludedExecutableDirectories: excludedToolExecutableDirectories,
    logger,
    manifestService,
  });
  const installService = new AgentInstallService({
    credentialManager,
    lifecycleRegistry,
  });

  api.registerChannel({ plugin: githubNotificationChannel });
  toolRegistry.registerTools(api, toolRuntime);
  toolRegistry.registerTrustedPolicies(api, manifestService, toolApprovals);
  registerAgentCommandSecurity(api, {
    logger,
    managedExecutableDirectories: excludedToolExecutableDirectories,
    manifestService,
  });
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
}
