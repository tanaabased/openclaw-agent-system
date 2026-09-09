import type AgentEnvironmentService from '../../environment/service.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { AgentSystemCapability } from '../../api/capability.ts';
import type { AgentSystemCliRunner } from '../../api/types.ts';
import GitHubAccountClient from '../../core/github-account-client.ts';
import GitHubAccountKeyService from './account-key-service.ts';
import GitHubConfigStore from './config-store.ts';
import createGitHubLifecycleContribution from './lifecycle.ts';
import OpenClawGitHubProfileAdapter from './openclaw-profile-adapter.ts';
import OpenClawGitHubProfileService from './openclaw-profile-service.ts';
import { createGitHubTool } from './tool.ts';

export interface GitHubCapabilityDependencies {
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  runCli: AgentSystemCliRunner;
  currentUid?: number;
  environmentService: Pick<AgentEnvironmentService, 'loadForWorkspace'>;
  excludedExecutableDirectories?: readonly string[];
  homeDirectory?: string;
  mutateConfigFile(params: {
    afterWrite: { mode: 'auto' };
    base: 'source';
    mutate(config: OpenClawConfig): boolean | void;
  }): Promise<{ result?: boolean }>;
  openClawStateDir: string;
  privateStateRoot?: string;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

export interface GitHubCapability extends AgentSystemCapability {
  accountClient: GitHubAccountClient;
}

/** Assemble the GitHub lifecycle and fixed-executable CLI tool. */
export default function createGitHubCapability(
  dependencies: GitHubCapabilityDependencies,
): GitHubCapability {
  const configStore = new GitHubConfigStore({
    ...(dependencies.currentUid === undefined ? {} : { currentUid: dependencies.currentUid }),
    ...(dependencies.privateStateRoot === undefined
      ? {}
      : { rootDir: dependencies.privateStateRoot }),
  });
  const profileAdapter = new OpenClawGitHubProfileAdapter({
    ...(dependencies.currentUid === undefined ? {} : { currentUid: dependencies.currentUid }),
  });
  const accountClient = new GitHubAccountClient({
    runCli: dependencies.runCli,
    baseEnvironment: dependencies.baseEnvironment,
    configStore,
    credentialMaterializer: profileAdapter,
    environmentService: dependencies.environmentService,
    excludedExecutableDirectories: dependencies.excludedExecutableDirectories,
  });
  const accountKeyService = new GitHubAccountKeyService({
    client: accountClient,
    ...(dependencies.homeDirectory === undefined
      ? {}
      : { homeDirectory: dependencies.homeDirectory }),
  });
  const profileService = new OpenClawGitHubProfileService({
    accountClient,
    ...(dependencies.currentUid === undefined ? {} : { currentUid: dependencies.currentUid }),
    mutateConfigFile: dependencies.mutateConfigFile,
    profileAdapter,
    readConfig: dependencies.readConfig,
    stateDir: dependencies.openClawStateDir,
  });

  return {
    accountClient,
    lifecycleContributions: [
      createGitHubLifecycleContribution({
        accountKeyService,
        configStore,
        profileService,
      }),
    ],
    tools: [createGitHubTool({ configStore })],
  };
}
