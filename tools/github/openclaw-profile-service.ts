import type { ProviderDiagnostic } from '../../utils/provider-diagnostic.ts';
import githubDiagnostic from '../../credentials/github-diagnostic.ts';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import {
  type ConnectedGitHubAccountClient,
  type GitHubAccountGitAuthor,
  GitHubAccountClientError,
} from '../../core/github-account-client.ts';
import { configuredAgentValue } from '../../core/configured-agents.ts';
import ensurePrivateStateDirectories from '../../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../../core/private-state-file.ts';
import type { AgentManifest } from '../../manifest/types.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';
import {
  OpenClawGitHubProfileError,
  type OpenClawGitHubProfileValidator,
} from './openclaw-profile-adapter.ts';

export { OpenClawGitHubProfileError } from './openclaw-profile-adapter.ts';

const adapterVersion = 1;
const markerName = '.agent-system-profile.json';
const profileIdPattern = /^ghp_[a-f0-9]{32}$/u;

interface AgentSystemProfileMarker {
  account: {
    login: string;
    nodeId: string;
  };
  agentId: string;
  credentialFingerprint: string;
  owner: 'openclaw-agent-system';
  profileId: string;
  schemaVersion: 1;
}

interface GitHubProfileBinding {
  gitAuthor?: GitHubAccountGitAuthor;
  profileId: string;
}

interface ProfilePaths {
  agentRoot: string;
  directories: string[];
  profileDir: string;
}

type ManagedProfileConnection = ConnectedGitHubAccountClient & {
  credentialFingerprint: string;
  materializeCredential(directory: string): Promise<void>;
  verifyConfiguredIdentity(configDirectory: string): Promise<unknown>;
};

export interface OpenClawGitHubProfileInspection {
  providerDiagnostic?: ProviderDiagnostic;
  code: string;
  message: string;
  status: 'blocked' | 'drift' | 'ready';
}

export interface OpenClawGitHubProfileReconciliation {
  bindingStatus: 'unchanged' | 'updated';
  profileId: string;
  profileStatus: 'created' | 'unchanged';
}

export interface OpenClawGitHubProfileServiceDependencies {
  accountClient: {
    connect(context: {
      manifest: AgentManifest;
      workspaceDir: string;
    }): Promise<ConnectedGitHubAccountClient>;
  };
  currentUid?: number;
  mutateConfigFile(params: {
    afterWrite: { mode: 'auto' };
    base: 'source';
    mutate(config: OpenClawConfig): boolean | void;
  }): Promise<{ result?: boolean }>;
  profileAdapter: OpenClawGitHubProfileValidator;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  stateDir: string;
}

function normalizeAgentId(agentId: string): string {
  return agentId.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameGitAuthor(
  left: GitHubAccountGitAuthor | undefined,
  right: GitHubAccountGitAuthor | undefined,
): boolean {
  return left?.email === right?.email && left?.name === right?.name;
}

function sameBinding(left: GitHubProfileBinding | undefined, right: GitHubProfileBinding): boolean {
  return Boolean(
    left && left.profileId === right.profileId && sameGitAuthor(left.gitAuthor, right.gitAuthor),
  );
}

/** Reconcile one Agent System agent into OpenClaw's guarded per-agent PAT profile layout. */
export default class OpenClawGitHubProfileService {
  readonly #accountClient: OpenClawGitHubProfileServiceDependencies['accountClient'];
  readonly #currentUid: number | undefined;
  readonly #mutateConfigFile: OpenClawGitHubProfileServiceDependencies['mutateConfigFile'];
  readonly #profileAdapter: OpenClawGitHubProfileValidator;
  readonly #readConfig: OpenClawGitHubProfileServiceDependencies['readConfig'];
  readonly #stateDir: string;

  constructor(dependencies: OpenClawGitHubProfileServiceDependencies) {
    this.#accountClient = dependencies.accountClient;
    this.#currentUid = dependencies.currentUid;
    this.#mutateConfigFile = dependencies.mutateConfigFile;
    this.#profileAdapter = dependencies.profileAdapter;
    this.#readConfig = dependencies.readConfig;
    this.#stateDir = resolve(dependencies.stateDir);
  }

  async inspect(context: {
    manifest: AgentManifest;
    workspaceDir: string;
  }): Promise<OpenClawGitHubProfileInspection> {
    let connected: ConnectedGitHubAccountClient;
    try {
      connected = await this.#accountClient.connect(context);
    } catch (error) {
      return {
        ...(error instanceof GitHubAccountClientError && error.providerDiagnostic
          ? { providerDiagnostic: error.providerDiagnostic }
          : {}),
        code:
          error instanceof GitHubAccountClientError
            ? error.code
            : 'openclaw-github-profile-account-unavailable',
        message:
          error instanceof GitHubAccountClientError
            ? error.message
            : 'The Agent System GitHub account could not be inspected.',
        status: 'blocked',
      };
    }

    try {
      const profileConnection = this.#profileConnection(connected);
      const expected = this.#expectedBinding(context.manifest.agent.id, profileConnection);
      const current = this.#binding(await this.#readConfig(), context.manifest.agent.id);
      if (!current) {
        return {
          code: 'openclaw-github-profile-missing',
          message: 'The agent does not have an OpenClaw GitHub identity override.',
          status: 'drift',
        };
      }
      if (current.profileId !== expected.profileId) {
        await this.#assertOwnedBinding(context.manifest.agent.id, current.profileId);
        return {
          code: 'openclaw-github-profile-stale',
          message: 'The agent is bound to an earlier Agent System GitHub profile generation.',
          status: 'drift',
        };
      }
      if (!sameGitAuthor(current.gitAuthor, expected.gitAuthor)) {
        return {
          code: 'openclaw-github-profile-author-drift',
          message: 'The OpenClaw GitHub author does not match the Agent System manifest.',
          status: 'drift',
        };
      }
      const profile = await this.#inspectProfile(context.manifest.agent.id, profileConnection);
      if (profile === 'missing') {
        return {
          code: 'openclaw-github-profile-files-missing',
          message: 'The agent-scoped OpenClaw GitHub profile files are missing.',
          status: 'drift',
        };
      }
      try {
        await profileConnection.verifyConfiguredIdentity(
          this.#paths(context.manifest.agent.id, expected.profileId).profileDir,
        );
      } catch (error) {
        if (error instanceof GitHubAccountClientError) throw error;
        throw new GitHubAccountClientError(
          'github-account-profile-identity-failed',
          'GitHub rejected the managed profile identity check.',
          undefined,
          githubDiagnostic({}, 'identity-check'),
        );
      }
      return {
        code: 'openclaw-github-profile-ready',
        message: 'The agent-scoped OpenClaw GitHub identity matches the Agent System manifest.',
        status: 'ready',
      };
    } catch (error) {
      return {
        code:
          error instanceof OpenClawGitHubProfileError || error instanceof GitHubAccountClientError
            ? error.code
            : 'openclaw-github-profile-inspection-failed',
        ...(error instanceof GitHubAccountClientError && error.providerDiagnostic
          ? { providerDiagnostic: error.providerDiagnostic }
          : {}),
        message:
          error instanceof Error
            ? error.message
            : 'The agent-scoped OpenClaw GitHub profile could not be inspected.',
        status: 'blocked',
      };
    }
  }

  async reconcile(context: {
    manifest: AgentManifest;
    workspaceDir: string;
  }): Promise<OpenClawGitHubProfileReconciliation> {
    const agentId = context.manifest.agent.id;
    const connected = this.#profileConnection(await this.#accountClient.connect(context));
    const expected = this.#expectedBinding(agentId, connected);
    const before = this.#binding(await this.#readConfig(), agentId);
    if (before && before.profileId !== expected.profileId) {
      await this.#assertOwnedBinding(agentId, before.profileId);
    }

    const profileStatus = await this.#ensureProfile(agentId, connected);
    let bindingStatus: 'unchanged' | 'updated' = 'unchanged';
    if (!sameBinding(before, expected)) {
      const beforeProfileId = before?.profileId;
      const mutation = await this.#mutateConfigFile({
        afterWrite: { mode: 'auto' },
        base: 'source',
        mutate: (config) => {
          const agent = configuredAgentValue(config, agentId);
          if (!agent) {
            throw new OpenClawGitHubProfileError(
              'openclaw-github-profile-agent-missing',
              `OpenClaw agent ${agentId} is unavailable for GitHub identity setup.`,
            );
          }
          const current = this.#binding(config, agentId);
          if (current?.profileId !== beforeProfileId) {
            throw new OpenClawGitHubProfileError(
              'openclaw-github-profile-concurrent-change',
              'The OpenClaw GitHub identity changed during Agent System installation.',
            );
          }
          if (sameBinding(current, expected)) return false;
          agent.tools ??= {};
          agent.tools.github = {
            profileId: expected.profileId,
            ...(expected.gitAuthor === undefined ? {} : { gitAuthor: { ...expected.gitAuthor } }),
          };
          return true;
        },
      });
      bindingStatus = mutation.result === false ? 'unchanged' : 'updated';
    }

    const verification = this.#binding(await this.#readConfig(), agentId);
    if (!sameBinding(verification, expected)) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-verification-failed',
        `OpenClaw GitHub identity for ${agentId} did not match after installation.`,
      );
    }
    await connected.verifyConfiguredIdentity(this.#paths(agentId, expected.profileId).profileDir);
    return { bindingStatus, profileId: expected.profileId, profileStatus };
  }

  #binding(config: OpenClawConfig, agentId: string): GitHubProfileBinding | undefined {
    const github = configuredAgentValue(config, agentId)?.tools?.github;
    if (!github) return undefined;
    return {
      profileId: github.profileId,
      ...(github.gitAuthor === undefined
        ? {}
        : {
            gitAuthor: {
              ...(github.gitAuthor.email === undefined ? {} : { email: github.gitAuthor.email }),
              ...(github.gitAuthor.name === undefined ? {} : { name: github.gitAuthor.name }),
            },
          }),
    };
  }

  #expectedBinding(agentId: string, connected: ManagedProfileConnection): GitHubProfileBinding {
    const profileId = this.#profileId(agentId, connected);
    return {
      profileId,
      ...(connected.gitAuthor === undefined ? {} : { gitAuthor: { ...connected.gitAuthor } }),
    };
  }

  async #ensureProfile(
    agentId: string,
    connected: ManagedProfileConnection,
  ): Promise<'created' | 'unchanged'> {
    const profileId = this.#profileId(agentId, connected);
    const inspection = await this.#inspectProfile(agentId, connected);
    if (inspection === 'ready') return 'unchanged';

    const paths = this.#paths(agentId, profileId);
    await ensurePrivateStateDirectories({
      ...(this.#currentUid === undefined ? {} : { currentUid: this.#currentUid }),
      directories: paths.directories.slice(0, -1),
      label: 'OpenClaw GitHub profile',
    });
    const stagingRoot = await mkdtemp(join(paths.agentRoot, '.agent-system-github-staging-'));
    const stagedProfile = join(stagingRoot, 'profile');
    try {
      await chmod(stagingRoot, 0o700);
      await mkdir(stagedProfile, { mode: 0o700 });
      await connected.materializeCredential(stagedProfile);
      await this.#profileAdapter.validate({
        credentialFingerprint: connected.credentialFingerprint,
        directories: [...paths.directories.slice(0, -1), stagingRoot, stagedProfile],
        profileDir: stagedProfile,
      });
      await this.#markerFile(agentId, profileId, stagedProfile, [
        ...paths.directories.slice(0, -1),
        stagingRoot,
        stagedProfile,
      ]).write(
        `${JSON.stringify(
          {
            account: connected.identity,
            agentId: normalizeAgentId(agentId),
            credentialFingerprint: connected.credentialFingerprint,
            owner: 'openclaw-agent-system',
            profileId,
            schemaVersion: adapterVersion,
          } satisfies AgentSystemProfileMarker,
          undefined,
          2,
        )}\n`,
      );
      await rename(stagedProfile, paths.profileDir);
      return 'created';
    } catch (error) {
      throw error instanceof OpenClawGitHubProfileError || error instanceof GitHubAccountClientError
        ? error
        : new OpenClawGitHubProfileError(
            'openclaw-github-profile-materialization-failed',
            'The agent-scoped OpenClaw GitHub profile could not be materialized safely.',
            { cause: error },
          );
    } finally {
      await rm(stagingRoot, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  async #inspectProfile(
    agentId: string,
    connected: ManagedProfileConnection,
  ): Promise<'missing' | 'ready'> {
    const profileId = this.#profileId(agentId, connected);
    const paths = this.#paths(agentId, profileId);
    const markerRaw = await this.#markerFile(
      agentId,
      profileId,
      paths.profileDir,
      paths.directories,
    ).read();
    if (markerRaw === undefined) {
      try {
        await lstat(paths.profileDir);
      } catch (error) {
        if (nodeErrorCode(error) === 'ENOENT') return 'missing';
        throw error;
      }
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-conflict',
        'The expected OpenClaw GitHub profile is not owned by Agent System.',
      );
    }
    const marker = this.#parseMarker(markerRaw);
    if (
      marker.agentId !== normalizeAgentId(agentId) ||
      marker.profileId !== profileId ||
      marker.credentialFingerprint !== connected.credentialFingerprint ||
      marker.account.login.toLowerCase() !== connected.identity.login.toLowerCase() ||
      marker.account.nodeId !== connected.identity.nodeId
    ) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-conflict',
        'The expected OpenClaw GitHub profile does not match this Agent System agent.',
      );
    }
    await this.#profileAdapter.validate({
      credentialFingerprint: connected.credentialFingerprint,
      directories: this.#directoriesForProfile(paths.profileDir),
      profileDir: paths.profileDir,
    });
    return 'ready';
  }

  async #assertOwnedBinding(agentId: string, profileId: string): Promise<void> {
    if (!profileIdPattern.test(profileId)) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-conflict',
        'The agent is bound to an unsupported OpenClaw GitHub profile.',
      );
    }
    const paths = this.#paths(agentId, profileId);
    const markerRaw = await this.#markerFile(
      agentId,
      profileId,
      paths.profileDir,
      paths.directories,
    ).read();
    if (markerRaw === undefined) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-conflict',
        'The agent is bound to a GitHub profile that Agent System does not own.',
      );
    }
    const marker = this.#parseMarker(markerRaw);
    if (marker.agentId !== normalizeAgentId(agentId) || marker.profileId !== profileId) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-conflict',
        "The agent is bound to another agent's GitHub profile.",
      );
    }
  }

  #markerFile(
    agentId: string,
    profileId: string,
    profileDir: string,
    directories: string[],
  ): PrivateStateFile {
    return new PrivateStateFile({
      ...(this.#currentUid === undefined ? {} : { currentUid: this.#currentUid }),
      directories,
      label: `Agent System marker for ${normalizeAgentId(agentId)} profile ${profileId}`,
      maximumBytes: 8 * 1024,
      path: join(profileDir, markerName),
    });
  }

  #parseMarker(raw: string): AgentSystemProfileMarker {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-marker-invalid',
        'The Agent System GitHub profile marker is invalid.',
        { cause: error },
      );
    }
    if (
      !isRecord(value) ||
      value.schemaVersion !== adapterVersion ||
      value.owner !== 'openclaw-agent-system' ||
      typeof value.agentId !== 'string' ||
      typeof value.profileId !== 'string' ||
      !profileIdPattern.test(value.profileId) ||
      typeof value.credentialFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.credentialFingerprint) ||
      !isRecord(value.account) ||
      typeof value.account.login !== 'string' ||
      typeof value.account.nodeId !== 'string'
    ) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-marker-invalid',
        'The Agent System GitHub profile marker is invalid.',
      );
    }
    return value as unknown as AgentSystemProfileMarker;
  }

  #profileId(agentId: string, connected: ManagedProfileConnection): string {
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          adapterVersion,
          normalizeAgentId(agentId),
          connected.identity.login.toLowerCase(),
          connected.identity.nodeId,
          connected.credentialFingerprint,
        ]),
      )
      .digest('hex');
    return `ghp_${digest.slice(0, 32)}`;
  }

  #paths(agentId: string, profileId: string): ProfilePaths {
    if (!profileIdPattern.test(profileId)) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-id-invalid',
        'The managed OpenClaw GitHub profile id is invalid.',
      );
    }
    const credentialsDir = join(this.#stateDir, 'credentials');
    const githubDir = join(credentialsDir, 'github');
    const agentsDir = join(githubDir, 'agents');
    const agentKey = createHash('sha256').update(normalizeAgentId(agentId)).digest('hex');
    const agentRoot = join(agentsDir, agentKey);
    const profileDir = join(agentRoot, profileId);
    return {
      agentRoot,
      directories: [this.#stateDir, credentialsDir, githubDir, agentsDir, agentRoot, profileDir],
      profileDir,
    };
  }

  #profileConnection(connected: ConnectedGitHubAccountClient): ManagedProfileConnection {
    if (
      typeof connected.credentialFingerprint !== 'string' ||
      typeof connected.materializeCredential !== 'function' ||
      typeof connected.verifyConfiguredIdentity !== 'function'
    ) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-adapter-unavailable',
        'The guarded OpenClaw GitHub profile adapter is unavailable.',
      );
    }
    return connected as ManagedProfileConnection;
  }

  #directoriesForProfile(profileDir: string): string[] {
    const segments = relative(this.#stateDir, profileDir).split(sep);
    const directories = [this.#stateDir];
    for (const segment of segments) {
      directories.push(join(directories[directories.length - 1]!, segment));
    }
    return directories;
  }
}
