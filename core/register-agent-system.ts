import createGitHubStatusChannel from '../channels/github/channel.ts';
import createGitHubChannelLifecycle from '../agent/github-channel-lifecycle.ts';
import notificationAutomationReadiness, {
  type NotificationScheduler,
} from '../agent/automation-readiness.ts';
import OpenClawNotifications from '../agent/openclaw-notifications.ts';
import { openclawIntakeAutomationId } from '../agent/openclaw-intake-policy.ts';
import { readFile } from 'node:fs/promises';

import OpenClawIntake from '../agent/openclaw-intake.ts';
import createIntakeTool from '../tools/intake/tool.ts';
import createDispatchTool from '../tools/dispatch/tool.ts';
import GitHubWorkEventClient from '../channels/github/provider/work-event-client.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import GitHubWorkItemClient from '../channels/github/provider/work-item-client.ts';
import { join, resolve } from 'node:path';

import { listAgentIds } from 'openclaw/plugin-sdk/agent-scope-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { runPluginCommandWithTimeout } from 'openclaw/plugin-sdk/run-command';
import { resolveSecretRefValues } from 'openclaw/plugin-sdk/secret-ref-runtime';

import { withPrivateStateLock } from './private-state-lock-context.ts';
import createGoogleCapability from '../tools/google/capability.ts';
import createGitCapability from '../tools/git/capability.ts';
import createGitHubCapability from '../tools/github/capability.ts';
import resolveCodexCommandAgentId from '../agent/resolve-codex-command-id.ts';
import registerAgentCommandSecurity from '../agent/command-security.ts';
import AutomationService from '../agent/automation-service.ts';
import { requestAutomationGateway } from '../agent/automation-gateway.ts';
import BoundCommandService from '../agent/bound-command-service.ts';
import AgentCommandAuthority from '../agent/command-authority.ts';
import AgentDoctorService from '../agent/doctor-service.ts';
import AgentEnvironmentService from '../environment/service.ts';
import AgentInstallService from '../agent/install-service.ts';
import createSessionDispatchCredential from '../credentials/session-dispatch-runtime.ts';
import createSessionDispatchLifecycle from '../agent/session-dispatch-lifecycle.ts';
import createCollaborationLifecycleContribution from '../agent/collaboration-lifecycle.ts';
import AgentLifecycleApproval from '../agent/lifecycle-approval.ts';
import createInstallTool from '../tools/install/tool.ts';
import createDoctorTool from '../tools/doctor/tool.ts';
import createModelRoutingTool from '../tools/model-routing/tool.ts';
import { registerLifecycleApprovalHook } from './lifecycle-approval-hook.ts';
import SetupCommandService from '../agent/setup-command-service.ts';
import SetupLifecycleService from '../agent/setup-lifecycle.ts';
import createAgentLifecycleContribution from '../agent/lifecycle.ts';
import createModelLifecycleContribution from '../agent/model-lifecycle.ts';
import createCodexPluginLifecycleContribution from '../agent/codex-plugin-lifecycle.ts';
import codexPluginRequirement from './codex-plugin-metadata.ts';
import ensurePrivateStateDirectories from './ensure-private-state-directories.ts';
import acquirePrivateStateFileLock from './private-state-file-lock.ts';
import parseModelCatalogRows from '../agent/model-catalog.ts';
import createMemoryLifecycleContribution from '../agent/memory-lifecycle.ts';
import {
  createMemorySecretProviderConfiguration,
  memorySecretProviderAlias,
} from '../agent/memory-secret-provider-configuration.ts';
import { parseMemoryStatus } from '../agent/memory-status.ts';
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
import WorkspaceBackupService from '../agent/backup-service.ts';
import readFreshRuntimeConfig from './read-fresh-runtime-config.ts';
import resolvePackageDirectory from './package-directory.ts';
import registerOpCache from './register-op-cache.ts';
import { requestOpCacheGateway } from '../cli/credentials-cache.ts';

/** Assemble and register the complete Agent System runtime. */
export default function registerAgentSystem(api: OpenClawPluginApi, runtimeUrl: string): void {
  const packageDir = resolvePackageDirectory(api, runtimeUrl);
  const logger = createAgentSystemLogger(api.logger, api.id);
  const lifecycleLogger = createAgentSystemLifecycleLogger(api.logger, api.id, {
    getChildLogger(bindings) {
      return api.runtime.logging.getChildLogger(bindings);
    },
  });
  const privateStateRoot = resolveFileCredentialStoreRoot(process.env);
  const readConfig = readFreshRuntimeConfig;
  const sessionDispatch = createSessionDispatchCredential({
    stateDir: api.runtime.state.resolveStateDir(),
    readConfig,
  });
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
  const googleCapability = createGoogleCapability({
    ...capabilityDependencies,
    environmentService: lifecycleEnvironmentService,
    privateStateRoot,
  });
  const intakeV2 = new OpenClawIntake({
    root: join(privateStateRoot ?? api.runtime.state.resolveStateDir(), 'agent-system-intake-v2'),
    namespace: api.runtime.state.resolveStateDir(),
    manifestService: lifecycleManifestService,
    async connect(input, signal) {
      const connected = await githubCapability.accountClient.connect(input, 'service', signal);
      return new GitHubWorkItemClient(new GitHubWorkEventApiClient(connected));
    },
  });
  const automationDependencies = {
    root: join(api.runtime.state.resolveStateDir(), 'agent-system-automations'),
    profile: api.runtime.state.resolveStateDir(),
    command: openClawCommand,
    environment: Object.fromEntries(
      ['OPENCLAW_PROFILE', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'].flatMap((name) =>
        process.env[name] ? [[name, process.env[name]!]] : [],
      ),
    ),
    manifestService: lifecycleManifestService,
  };
  const automationService = new AutomationService(automationDependencies);
  const dispatchV2 = createDispatchTool({
    api,
    config: readRuntimeConfig,
    root: join(privateStateRoot ?? api.runtime.state.resolveStateDir(), 'agent-system-dispatch-v2'),
    intake: intakeV2,
    credential: sessionDispatch,
    automations: automationService,
    manifestService: lifecycleManifestService,
    worktrees: gitCapability.trustedWorktreeService,
    async connect(input, signal) {
      const connected = await githubCapability.accountClient.connect(input, 'service', signal);
      return new GitHubWorkEventClient(connected);
    },
  });
  const toolRegistry = new AgentSystemToolRegistry([
    dispatchV2.tool,
    createIntakeTool(intakeV2, {
      ...lifecycleManifestService,
      loadForCommandDirectory(...args) {
        if (!manifestServiceRef.current)
          throw new Error('Agent System manifest service is unavailable.');
        return manifestServiceRef.current.loadForCommandDirectory(...args);
      },
    }),
    ...gitCapability.tools,
    ...githubCapability.tools,
    ...googleCapability.tools,
    createInstallTool((): AgentLifecycleApproval => lifecycleApproval),
    createDoctorTool((): AgentLifecycleApproval => lifecycleApproval),
    createModelRoutingTool({
      ...lifecycleManifestService,
      loadForCommandDirectory(...args) {
        if (!manifestServiceRef.current)
          throw new Error('Agent System manifest service is unavailable.');
        return manifestServiceRef.current.loadForCommandDirectory(...args);
      },
    }),
  ]);
  const setupLifecycle = new SetupLifecycleService({
    run: (command, target, signal) => setupCommands.run(command, target, signal),
    runPreAgent: (command, target, signal) => setupCommands.runPreAgent(command, target, signal),
    prepare: (context) => setupCommands.prepare(context),
  });
  const collaboration = createCollaborationLifecycleContribution({
    readConfig,
    resolveAgentWorkspaceDir: (config, agentId) =>
      api.runtime.agent.resolveAgentWorkspaceDir(config, agentId),
    mutateConfigFile: (params) => api.runtime.config.mutateConfigFile(params),
  });
  const lifecycleContributions = [
    createCodexPluginLifecycleContribution({
      readConfig,
      async readRequirement() {
        return codexPluginRequirement(
          JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')),
        );
      },
      async readPluginPackage(rootDir) {
        return JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
      },
      async runOpenClawCommand(args, cwd, signal) {
        return api.runtime.system.runCommandWithTimeout([...openClawCommand, ...args], {
          cwd,
          timeoutMs: 120_000,
          killGraceMs: 100,
          killProcessTree: true,
          maxCombinedOutputBytes: 1_048_576,
          outputCapture: 'head',
          ...(signal ? { signal } : {}),
        });
      },
      async withLock(run) {
        const root = join(api.runtime.state.resolveStateDir(), 'agent-system-prerequisites');
        await ensurePrivateStateDirectories({
          directories: [root],
          currentUid,
          label: 'Shared Codex prerequisite',
        });
        const lock = await acquirePrivateStateFileLock(join(root, 'codex'), {
          retries: { factor: 1, minTimeout: 100, maxTimeout: 100, retries: 300 },
          staleMs: 30_000,
        });
        try {
          return await withPrivateStateLock(lock, run);
        } finally {
          await lock.release();
        }
      },
    }),
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
    createGitHubChannelLifecycle({
      readConfig,
      mutateConfigFile: (params) => api.runtime.config.mutateConfigFile(params),
    }),
    collaboration,
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
      resolveAllowedModelRef({ agentId, config, defaultProvider, raw }) {
        return api.runtime.modelConfig.resolveAllowedModelRef({
          agentId,
          catalog: [],
          cfg: config,
          defaultProvider,
          raw,
        });
      },
      resolveThinkingPolicy(params) {
        return api.runtime.agent.resolveThinkingPolicy(params);
      },
    }),
    createMemoryLifecycleContribution({
      async inspectMemoryStatus({ agentId, deep, workspaceDir }) {
        const result = await runPluginCommandWithTimeout({
          argv: [
            ...openClawCommand,
            'memory',
            'status',
            '--agent',
            agentId,
            ...(deep ? ['--deep'] : []),
            '--json',
          ],
          cwd: workspaceDir,
          timeoutMs: deep ? 120_000 : 30_000,
        });
        try {
          return parseMemoryStatus(result.stdout, agentId);
        } catch {
          throw new Error(result.stderr.trim() || `OpenClaw memory status exited ${result.code}.`);
        }
      },
      async inspectBinding({ agentId, binding }) {
        const service = environmentServiceRef.current;
        if (!service) return 'unavailable';
        const loaded = await service.loadForAgentId(agentId, 'cli');
        if (loaded.status !== 'loaded') return 'unavailable';
        const value = loaded.environment.values[binding];
        return value === undefined || value === '' ? 'missing' : 'available';
      },
      async inspectConfiguredSecret({ config, id }) {
        try {
          const resolved = await resolveSecretRefValues(
            [{ source: 'exec', provider: memorySecretProviderAlias, id }],
            { config, env: process.env },
          );
          const value = resolved.values().next().value;
          return typeof value === 'string' && value !== '' ? 'available' : 'unavailable';
        } catch {
          return 'unavailable';
        }
      },
      mutateConfigFile(params) {
        return api.runtime.config.mutateConfigFile(params);
      },
      readConfig,
      resolveSecretProviderConfiguration(config) {
        return createMemorySecretProviderConfiguration({
          config,
          nodeExecutable: process.execPath,
          packageDir,
        });
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
    ...googleCapability.lifecycleContributions,
    createSessionDispatchLifecycle(sessionDispatch),
    intakeV2.contribution(),
    automationService.contribution(),
  ];
  const lifecycleRegistry = new AgentSystemLifecycleRegistry(
    lifecycleContributions,
    setupLifecycle,
  );
  const manifestService = new AgentManifestService({
    getConfig: readConfig,
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
  let readScheduler: (() => NotificationScheduler | undefined) | undefined;
  api.registerService({
    id: 'agent-system-github-readiness',
    start(context) {
      readScheduler = context.getCron;
    },
    stop() {
      readScheduler = undefined;
    },
  });
  api.registerChannel({
    plugin: createGitHubStatusChannel({
      manifestService,
      intake: intakeV2,
      automationReadiness: (manifest, workspace) =>
        notificationAutomationReadiness(automationService, manifest, workspace, readScheduler?.()),
    }),
  });
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
  const doctorService = new AgentDoctorService({
    lifecycleRegistry,
    toolRegistry,
    baseEnvironment: process.env,
    excludedExecutableDirectories: excludedToolExecutableDirectories,
  });
  const toolRuntime = new AgentSystemToolRuntime({
    runCli,
    baseEnvironment: process.env,
    environmentService,
    excludedExecutableDirectories: excludedToolExecutableDirectories,
    logger: lifecycleLogger,
    manifestService,
  });
  const setupCommands: SetupCommandService = new SetupCommandService({
    baseEnvironment: process.env,
    ...(currentUid === undefined ? {} : { currentUid }),
    manifestService,
    packageDir,
    runCommandWithTimeout: (argv, options) =>
      api.runtime.system.runCommandWithTimeout(argv, options),
    toolRegistry,
    toolRuntime,
  });
  const installService = new AgentInstallService({
    sessionDispatch,
    credentialManager,
    lifecycleRegistry,
  });
  const lifecycleApproval = new AgentLifecycleApproval({
    manifestService,
    doctorService,
    installService,
  });
  registerLifecycleApprovalHook(api, lifecycleApproval);
  toolRegistry.registerTools(api, toolRuntime);
  toolRegistry.registerTrustedPolicies(api, manifestService);
  registerAgentCommandAuthority(api, {
    authority: commandAuthority,
    launcherDirectory: join(packageDir, 'bin'),
    logger,
    manifestService,
    toolRegistry,
  });
  registerAgentCommandSecurity(api, {
    logger,
    managedExecutableDirectories: excludedToolExecutableDirectories,
    manifestService,
  });
  registerAgentSystemHooks(api, manifestService, toolRegistry);
  api.registerCli(({ program }) => {
    const automations = new AutomationService({
      ...automationDependencies,
      request: requestAutomationGateway,
    });
    const operatorRegistry = new AgentSystemLifecycleRegistry(
      [
        ...lifecycleContributions.filter(({ id }) => id !== 'automations'),
        automations.contribution(),
      ],
      setupLifecycle,
    );
    const operatorInstall = new AgentInstallService({
      sessionDispatch,
      credentialManager,
      lifecycleRegistry: operatorRegistry,
    });
    const operatorDoctor = new AgentDoctorService({
      lifecycleRegistry: operatorRegistry,
      toolRegistry,
      baseEnvironment: process.env,
      excludedExecutableDirectories: excludedToolExecutableDirectories,
    });
    const boundCommands = new BoundCommandService({
      baseEnvironment: process.env,
      currentUid,
      manifestService,
      packageDir,
      toolRegistry,
      toolRuntime,
      runCommandWithTimeout: (argv, options) =>
        api.runtime.system.runCommandWithTimeout(argv, options),
    });
    registerAgentSystemCli(program, {
      backupService: new WorkspaceBackupService(
        async (agentId) => {
          const config = await readConfig();
          const agentDir = api.runtime.agent.resolveAgentDir(config, agentId);
          const agentIds = new Set([
            'main',
            agentId,
            ...(config.agents?.list ?? []).map(({ id }) => id),
          ]);
          return {
            paths: [agentDir],
            livePaths: [
              api.runtime.state.resolveStateDir(),
              ...[...agentIds].flatMap((id) => [
                api.runtime.agent.resolveAgentDir(config, id),
                api.runtime.agent.resolveAgentWorkspaceDir(config, id),
              ]),
            ],
            agentDir,
            openclawVersion: api.version ?? 'unavailable',
            stateDir: api.runtime.state.resolveStateDir(),
            workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(config, agentId),
          };
        },
        (args, cwd) =>
          runPluginCommandWithTimeout({
            argv: [...openClawCommand, ...args],
            cwd,
            timeoutMs: 600_000,
          }),
      ),
      commandAuthority,
      credentialInput: opCredentialInput,
      credentialManager,
      doctorService: operatorDoctor,
      environmentService,
      input: process.stdin,
      installService: operatorInstall,
      automations,
      boundCommands,
      manifestService,
      nativeNotifications: new OpenClawNotifications({
        root: join(
          privateStateRoot ?? api.runtime.state.resolveStateDir(),
          'agent-system-dispatch-v2',
        ),
        intake: intakeV2,
        inspectRun: async (manifest, workspace, runId, signal) => {
          signal.throwIfAborted();
          const history = await automations.runs(manifest, workspace, openclawIntakeAutomationId, {
            limit: 1,
            offset: 0,
            runId,
          });
          const entry = history.entries[0];
          return !entry || entry.execution === 'unavailable'
            ? 'pending'
            : entry.execution === 'ok'
              ? 'completed'
              : 'failed';
        },
        requestRun: (manifest, workspace, signal) =>
          new AutomationService({
            ...automationDependencies,
            request: (method, params) => {
              signal.throwIfAborted();
              return requestAutomationGateway(method, params);
            },
          }).run(manifest, workspace, openclawIntakeAutomationId),
      }),
      toolRegistry,
      toolRuntime,
    });
  }, agentSystemCliMetadata);
}
