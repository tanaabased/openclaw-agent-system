import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from 'openclaw/plugin-sdk/config-runtime';
import { definePluginEntry, type OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import { runPluginCommandWithTimeout } from 'openclaw/plugin-sdk/run-command';

import createAgentLifecycleContribution from './lib/agent-lifecycle.ts';
import AgentEnvironmentService from './lib/agent-environment-service.ts';
import AgentDoctorService from './lib/agent-doctor-service.ts';
import AgentInstallService from './lib/agent-install-service.ts';
import AgentPathService from './lib/agent-path-service.ts';
import AgentManifestService, { type ManifestLoadTrigger } from './lib/agent-manifest-service.ts';
import createCredentialStores from './lib/credential-store-registry.ts';
import CodexPathConfigService from './lib/codex-path-config-service.ts';
import defineAgentSystemSemanticTool from './lib/define-agent-system-semantic-tool.ts';
import { resolveFileCredentialStoreRoot } from './lib/file-credential-store.ts';
import OpCredentialManager from './lib/op-credential-manager.ts';
import OpCredentialInput from './lib/op-credential-input.ts';
import OpCredentialService from './lib/op-credential-service.ts';
import OpEnvironmentService from './lib/op-environment-service.ts';
import PathProjectionStore from './lib/path-projection-store.ts';
import createPathLifecycleContribution from './lib/path-lifecycle.ts';
import AgentSystemLifecycleRegistry from './lib/lifecycle-registry.ts';
import AgentSystemToolRegistry from './lib/tool-registry.ts';
import AgentSystemToolApprovalReceiptStore from './lib/tool-approval-receipt-store.ts';
import AgentSystemToolRuntime from './lib/tool-runtime.ts';
import { createAgentSystemLogger } from './lib/logger.ts';
import registerAgentSystemCli from './lib/register-cli.ts';
import registerAgentSystemHooks from './lib/register-hooks.ts';
import WorkspaceGitignoreService from './lib/workspace-gitignore-service.ts';
import createGitLifecycleContribution from './tools/git/lifecycle.ts';
import createGitExtensionResolver from './tools/git/extension.ts';
import GitSshResourceService from './tools/git/ssh-resource-service.ts';
import { createGitTool } from './tools/git/tool.ts';
import GitWorktreeGitRunnerFactory from './tools/git/worktree-git-runner.ts';
import GitWorktreeLayoutService from './tools/git/worktree-layout-service.ts';
import GitWorktreeService from './tools/git/worktree-service.ts';
import { createGitWorktreeToolDefinition } from './tools/git/worktree-tool.ts';
import GitHubAccountClient from './tools/github/account-client.ts';
import GitHubAccountKeyService from './tools/github/account-key-service.ts';
import GitHubConfigStore from './tools/github/config-store.ts';
import createGitHubLifecycleContribution from './tools/github/lifecycle.ts';
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
    const privateStateRoot = resolveFileCredentialStoreRoot(process.env);
    const readConfig = () => {
      // Child OpenClaw commands mutate the config outside this process, so bypass its pinned snapshot.
      return loadConfig({ pin: false });
    };
    const cliEntry = process.argv[1] ? resolve(process.argv[1]) : undefined;
    const openClawCommand = cliEntry ? [process.execPath, cliEntry] : ['openclaw'];
    const githubConfigStore = new GitHubConfigStore({
      currentUid: process.getuid?.(),
      rootDir: privateStateRoot,
    });
    const toolLauncherDirectory = process.env.AGENT_SYSTEM_TOOL_LAUNCHER_DIR?.trim();
    const excludedToolExecutableDirectories = [
      join(packageDir, 'bin'),
      ...(toolLauncherDirectory ? [toolLauncherDirectory] : []),
    ];
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
    const githubAccountKeyService = new GitHubAccountKeyService({
      client: new GitHubAccountClient({
        baseEnvironment: process.env,
        configStore: githubConfigStore,
        environmentService: lifecycleEnvironmentService,
        excludedExecutableDirectories: excludedToolExecutableDirectories,
      }),
      ...(process.env.HOME ? { homeDirectory: process.env.HOME } : {}),
    });
    const gitSshResourceService = new GitSshResourceService({
      authenticationLauncherPath: join(packageDir, 'bin', 'agent-system-ssh'),
      baseEnvironment: process.env,
      ...(process.getuid === undefined ? {} : { currentUid: process.getuid() }),
      excludedExecutableDirectories: excludedToolExecutableDirectories,
      ...(process.env.HOME ? { homeDirectory: process.env.HOME } : {}),
      signingKeyLauncherPath: join(packageDir, 'bin', 'agent-system-ssh-signing-key'),
      signingProgramPath: join(packageDir, 'bin', 'agent-system-ssh-keygen'),
    });
    const gitExtensionAvailable = createGitExtensionResolver({
      excludedExecutableDirectories: excludedToolExecutableDirectories,
      path: process.env.PATH ?? '',
    });
    const gitWorktreeLayoutService = new GitWorktreeLayoutService({
      baseEnvironment: process.env,
      ...(process.getuid === undefined ? {} : { currentUid: process.getuid() }),
      excludedExecutableDirectories: excludedToolExecutableDirectories,
      gitignoreService,
      ...(process.env.HOME ? { homeDirectory: process.env.HOME } : {}),
    });
    const gitWorktreeService = new GitWorktreeService({
      layoutService: gitWorktreeLayoutService,
    });
    const gitWorktreeRunnerFactory = new GitWorktreeGitRunnerFactory({
      baseEnvironment: process.env,
      excludedExecutableDirectories: excludedToolExecutableDirectories,
      sshResourceService: gitSshResourceService,
    });
    const gitWorktreeDefinition = createGitWorktreeToolDefinition({
      runnerFactory: gitWorktreeRunnerFactory,
      service: gitWorktreeService,
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
      createPathLifecycleContribution({ pathService }),
      createGitLifecycleContribution({
        sshResourceService: gitSshResourceService,
        worktreeLayoutService: gitWorktreeLayoutService,
      }),
      createGitHubLifecycleContribution({
        accountKeyService: githubAccountKeyService,
        configStore: githubConfigStore,
      }),
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
      createGitTool({
        extensionAvailable: gitExtensionAvailable,
        sshResourceService: gitSshResourceService,
      }),
      defineAgentSystemSemanticTool(gitWorktreeDefinition),
      createGitHubTool({ configStore: githubConfigStore }),
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
    toolRegistry.registerTools(api, toolRuntime);
    toolRegistry.registerTrustedPolicies(api, manifestService, toolApprovals);
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
