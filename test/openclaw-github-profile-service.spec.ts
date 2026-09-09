import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import {
  type ConnectedGitHubAccountClient,
  GitHubAccountClientError,
} from '../core/github-account-client.ts';
import type { AgentManifest } from '../manifest/types.ts';
import OpenClawGitHubProfileService, {
  OpenClawGitHubProfileError,
} from '../tools/github/openclaw-profile-service.ts';

const agentId = 'emori';
const systemProfileId = 'ghp_ffffffffffffffffffffffffffffffff';
const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { email: 'emori@tanaab.dev', id: agentId, name: 'EMORI' },
  github: { token: 'GH_TOKEN_EMORI', username: 'emoriwan' },
};
const context = { manifest, workspaceDir: '/workspace/emori' };

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function profileDir(stateDir: string, profileId: string): string {
  const agentKey = createHash('sha256').update(agentId).digest('hex');
  return join(stateDir, 'credentials', 'github', 'agents', agentKey, profileId);
}

async function createHarness() {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-system-openclaw-profile-'));
  await chmod(stateDir, 0o700);
  let token = 'private-token';
  let verificationError: Error | undefined;
  let materializations = 0;
  const config: OpenClawConfig = {
    agents: { entries: { [agentId]: { workspace: context.workspaceDir } } },
    tools: { github: { profileId: systemProfileId } },
  };
  const connection = (): ConnectedGitHubAccountClient => ({
    credentialFingerprint: fingerprint(token),
    execute: async () => ({
      exitCode: 0,
      stderr: '',
      stdout: '',
      timedOut: false,
      truncated: false,
    }),
    gitAuthor: { email: 'emori@tanaab.dev', name: 'EMORI' },
    identity: { login: 'emoriwan', nodeId: 'U_emori' },
    async materializeProfile(directory) {
      materializations += 1;
      await writeFile(
        join(directory, 'hosts.yml'),
        `github.com:\n  user: emoriwan\n  oauth_token: ${token}\n`,
        { mode: 0o600 },
      );
      await writeFile(join(directory, 'config.yml'), 'version: "1"\n', { mode: 0o600 });
      return { login: 'emoriwan', nodeId: 'U_emori' };
    },
    async verifyProfile() {
      if (verificationError) throw verificationError;
      return { login: 'emoriwan', nodeId: 'U_emori' };
    },
  });
  const service = new OpenClawGitHubProfileService({
    accountClient: { connect: async () => connection() },
    currentUid: process.getuid?.(),
    async mutateConfigFile({ mutate }) {
      return { result: mutate(config) === true };
    },
    readConfig: () => config,
    stateDir,
  });
  return {
    config,
    materializations: () => materializations,
    remove: () => rm(stateDir, { force: true, recursive: true }),
    service,
    setToken(value: string) {
      token = value;
    },
    setVerificationError(error: Error | undefined) {
      verificationError = error;
    },
    stateDir,
  };
}

describe('tools/github/openclaw-profile-service', () => {
  it('should create and idempotently bind one private profile per agent', async () => {
    const harness = await createHarness();
    try {
      assert.deepEqual(await harness.service.inspect(context), {
        code: 'openclaw-github-profile-missing',
        message: 'The agent does not have an OpenClaw GitHub identity override.',
        status: 'drift',
      });

      const first = await harness.service.reconcile(context);
      assert.equal(first.profileStatus, 'created');
      assert.equal(first.bindingStatus, 'updated');
      assert.equal(harness.config.tools?.github?.profileId, systemProfileId);
      assert.equal(
        harness.config.agents?.entries?.[agentId]?.tools?.github?.profileId,
        first.profileId,
      );
      assert.deepEqual(harness.config.agents?.entries?.[agentId]?.tools?.github?.gitAuthor, {
        email: 'emori@tanaab.dev',
        name: 'EMORI',
      });

      const directory = profileDir(harness.stateDir, first.profileId);
      assert.equal((await lstat(directory)).mode & 0o077, 0);
      assert.equal((await lstat(join(directory, 'hosts.yml'))).mode & 0o077, 0);
      assert.equal((await lstat(join(directory, 'config.yml'))).mode & 0o077, 0);
      const marker = await readFile(join(directory, '.agent-system-profile.json'), 'utf8');
      assert.equal(marker.includes('private-token'), false);

      assert.deepEqual(await harness.service.reconcile(context), {
        bindingStatus: 'unchanged',
        profileId: first.profileId,
        profileStatus: 'unchanged',
      });
      assert.equal(harness.materializations(), 1);
      assert.equal((await harness.service.inspect(context)).status, 'ready');
    } finally {
      await harness.remove();
    }
  });

  it('should rotate to a new generation without removing the old profile', async () => {
    const harness = await createHarness();
    try {
      const first = await harness.service.reconcile(context);
      harness.setToken('rotated-token');
      const second = await harness.service.reconcile(context);

      assert.notEqual(second.profileId, first.profileId);
      assert.equal(second.profileStatus, 'created');
      assert.equal(second.bindingStatus, 'updated');
      assert.equal(
        (await lstat(profileDir(harness.stateDir, first.profileId))).isDirectory(),
        true,
      );
      assert.equal(
        (await lstat(profileDir(harness.stateDir, second.profileId))).isDirectory(),
        true,
      );
      assert.equal(harness.materializations(), 2);
    } finally {
      await harness.remove();
    }
  });

  it('should detect and repair manifest-derived git author drift', async () => {
    const harness = await createHarness();
    try {
      const first = await harness.service.reconcile(context);
      harness.config.agents!.entries![agentId]!.tools!.github!.gitAuthor = {
        email: 'other@example.com',
        name: 'Other',
      };

      assert.equal((await harness.service.inspect(context)).status, 'drift');
      assert.deepEqual(await harness.service.reconcile(context), {
        bindingStatus: 'updated',
        profileId: first.profileId,
        profileStatus: 'unchanged',
      });
      assert.deepEqual(harness.config.agents!.entries![agentId]!.tools!.github!.gitAuthor, {
        email: 'emori@tanaab.dev',
        name: 'EMORI',
      });
      assert.equal(harness.materializations(), 1);
    } finally {
      await harness.remove();
    }
  });

  it('should refuse to replace a manually managed agent profile', async () => {
    const harness = await createHarness();
    try {
      harness.config.agents!.entries![agentId]!.tools = {
        github: { profileId: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      };

      await assert.rejects(
        harness.service.reconcile(context),
        (error: unknown) =>
          error instanceof OpenClawGitHubProfileError &&
          error.code === 'openclaw-github-profile-conflict',
      );
      assert.equal(harness.materializations(), 0);
    } finally {
      await harness.remove();
    }
  });

  it('should report unavailable credentials and unsafe profile state as blocked', async () => {
    const harness = await createHarness();
    try {
      const reconciliation = await harness.service.reconcile(context);
      harness.setVerificationError(
        new GitHubAccountClientError(
          'github-account-profile-identity-failed',
          'GitHub rejected the managed profile identity check.',
        ),
      );
      assert.deepEqual(await harness.service.inspect(context), {
        code: 'github-account-profile-identity-failed',
        message: 'GitHub rejected the managed profile identity check.',
        status: 'blocked',
      });

      harness.setVerificationError(undefined);
      const markerPath = join(
        profileDir(harness.stateDir, reconciliation.profileId),
        '.agent-system-profile.json',
      );
      await unlink(markerPath);
      await symlink('hosts.yml', markerPath);
      const unsafe = await harness.service.inspect(context);
      assert.equal(unsafe.status, 'blocked');
      assert.equal(unsafe.message.includes('symbolic link'), true);
    } finally {
      await harness.remove();
    }
  });
});
