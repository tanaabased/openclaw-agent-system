import assert from 'node:assert/strict';

import type { AgentManifest } from '../manifest/types.ts';
import TrustedGitWorktreeService from '../tools/git/trusted-worktree-service.ts';
import { createGitWorktreeToolDefinition } from '../tools/git/worktree-tool.ts';
import { gitWorktreeDirectoryName } from '../tools/git/worktree-names.ts';

const manifest: AgentManifest = {
  agent: { email: 'data@example.com', id: 'data', name: 'Data' },
  git: { worktrees: {} },
  schemaVersion: 1,
};

function fixture(options: { deny?: boolean; listed?: boolean; ssh?: boolean } = {}) {
  const events: string[] = [];
  const prepared: Array<{
    baseRef: string;
    cloneUrl?: string;
    reconcileOrigin?: boolean;
    repositoryId: string;
    workId: string;
  }> = [];
  const configuredManifest: AgentManifest = options.ssh
    ? {
        ...manifest,
        git: {
          ssh: { privateKeys: [{ fromEnvironment: 'GIT_SSH_PRIVATE_KEY' }] },
          worktrees: {},
        },
      }
    : manifest;
  const environmentValues: Record<string, string> = options.ssh
    ? { GIT_SSH_PRIVATE_KEY: 'private-key' }
    : {};
  const baseDefinition = createGitWorktreeToolDefinition({
    runnerFactory: {
      async acquire(configuration, scope, acquireOptions) {
        events.push(acquireOptions?.authentication ? 'acquire-authenticated' : 'acquire-read');
        assert.equal(configuration.identity.name, 'Data');
        assert.equal(scope.workspaceDir, '/workspace/data');
        return {
          async dispose() {
            events.push('dispose');
          },
          git: {
            async run() {
              return { exitCode: 0, stderr: '', stdout: '' };
            },
          },
        };
      },
    },
    service: {
      async list() {
        events.push('list');
        return options.listed
          ? [
              {
                branch: gitWorktreeDirectoryName('github-7', 'issue-3'),
                path: '/workspace/data/.agent-system/worktrees/github-7/issue-3',
                repositoryId: 'github-7',
                status: 'active' as const,
              },
            ]
          : [];
      },
      async cleanup(_context, repositoryId, workId) {
        events.push('cleanup');
        assert.equal(repositoryId, 'github-7');
        assert.equal(workId, 'issue-3');
        return {
          branch: gitWorktreeDirectoryName(repositoryId, workId),
          path: '/workspace/data/.agent-system/worktrees/github-7/issue-3',
          repositoryId,
          status: 'removed' as const,
          workId,
        };
      },
      async prepare(_context, input) {
        events.push('prepare');
        prepared.push(input);
        return {
          branch: 'issue-3-branch',
          path: '/workspace/data/.agent-system/worktrees/github-7/issue-3',
          repositoryId: input.repositoryId,
          status: 'created' as const,
          workId: input.workId,
        };
      },
      async remove() {
        throw new Error('not used');
      },
    },
  });
  const authorize = baseDefinition.authorization?.authorize;
  assert.ok(authorize);
  const definition = {
    ...baseDefinition,
    authorization: {
      ...baseDefinition.authorization,
      async authorize(...arguments_: Parameters<NonNullable<typeof authorize>>) {
        events.push('authorize');
        if (options.deny) return { reason: 'denied for test', status: 'denied' as const };
        return authorize(...arguments_);
      },
    },
  };
  const service = new TrustedGitWorktreeService({
    definition,
    environmentService: {
      async loadForAgentId(agentId, trigger) {
        events.push('environment');
        assert.equal(agentId, 'data');
        assert.equal(trigger, 'service');
        return {
          diagnostics: [],
          digest: 'digest',
          environment: {
            values: environmentValues,
            variables: [],
          },
          manifest: configuredManifest,
          path: '/workspace/data/agent.yaml',
          scope: { agentId: 'data', workspaceDir: '/workspace/data' },
          status: 'loaded' as const,
          validationChecks: [],
        };
      },
    },
    manifestService: {
      async loadForAgentId(agentId, trigger) {
        events.push('manifest');
        assert.equal(agentId, 'data');
        assert.equal(trigger, 'service');
        return {
          diagnostics: [],
          digest: 'digest',
          manifest: configuredManifest,
          path: '/workspace/data/agent.yaml',
          scope: { agentId: 'data', workspaceDir: '/workspace/data' },
          status: 'loaded' as const,
          validationChecks: [],
        };
      },
    },
  });
  return { events, prepared, service };
}

describe('tools/git/trusted-worktree-service', () => {
  it('should authorize before resolving values and reuse the worktree definition', async () => {
    const { events, prepared, service } = fixture();

    const result = await service.prepareGitHub({
      agentId: 'data',
      cloneUrl: 'https://github.com/tanaabased/openclaw-agent-system.git',
      defaultBranch: 'main',
      itemDatabaseId: 3,
      itemType: 'issue',
      repositoryDatabaseId: 7,
    });

    assert.deepEqual(events, [
      'manifest',
      'authorize',
      'environment',
      'acquire-authenticated',
      'prepare',
      'dispose',
    ]);
    assert.deepEqual(prepared, [
      {
        baseRef: 'origin/main',
        cloneUrl: 'https://github.com/tanaabased/openclaw-agent-system.git',
        reconcileOrigin: true,
        repositoryId: 'github-7',
        workId: 'issue-3',
      },
    ]);
    assert.equal(result.repositoryId, 'github-7');
    assert.equal(result.workId, 'issue-3');
  });

  it('should not resolve environment values when git authorization is denied', async () => {
    const { events, service } = fixture({ deny: true });

    await assert.rejects(
      service.prepareGitHub({
        agentId: 'data',
        cloneUrl: 'https://github.com/tanaabased/openclaw-agent-system.git',
        defaultBranch: 'main',
        itemDatabaseId: 3,
        itemType: 'issue',
        repositoryDatabaseId: 7,
      }),
      /denied for test/u,
    );
    assert.deepEqual(events, ['manifest', 'authorize']);
  });

  it('should reuse configured git ssh for provider-derived github worktrees', async () => {
    const { prepared, service } = fixture({ ssh: true });

    await service.prepareGitHub({
      agentId: 'data',
      cloneUrl: 'https://github.com/tanaabased/openclaw-agent-system.git',
      defaultBranch: 'main',
      itemDatabaseId: 3,
      itemType: 'issue',
      repositoryDatabaseId: 7,
    });

    assert.equal(prepared[0]?.cloneUrl, 'git@github.com:tanaabased/openclaw-agent-system.git');
  });

  it('should inspect the deterministic worktree through the read-only definition', async () => {
    const { events, service } = fixture({ listed: true });

    const result = await service.inspectGitHub({
      agentId: 'data',
      cloneUrl: 'https://github.com/tanaabased/openclaw-agent-system.git',
      defaultBranch: 'main',
      itemDatabaseId: 3,
      itemType: 'issue',
      repositoryDatabaseId: 7,
    });

    assert.equal(result?.workId, 'issue-3');
    assert.equal(result?.repositoryId, 'github-7');
    assert.deepEqual(events, [
      'manifest',
      'authorize',
      'environment',
      'acquire-read',
      'list',
      'dispose',
    ]);
  });

  it('should re-inspect the exact checkpoint before trusted cleanup', async () => {
    const { events, service } = fixture({ listed: true });
    const expected = {
      branch: gitWorktreeDirectoryName('github-7', 'issue-3'),
      path: '/workspace/data/.agent-system/worktrees/github-7/issue-3',
    };

    const result = await service.cleanupGitHub({
      agentId: 'data',
      cloneUrl: 'https://github.com/tanaabased/openclaw-agent-system.git',
      defaultBranch: 'main',
      itemDatabaseId: 3,
      itemType: 'issue',
      repositoryDatabaseId: 7,
      worktree: expected,
    });

    assert.deepEqual(result, {
      ...expected,
      repositoryId: 'github-7',
      status: 'removed',
      workId: 'issue-3',
    });
    assert.deepEqual(events, [
      'manifest',
      'authorize',
      'environment',
      'acquire-read',
      'list',
      'dispose',
      'manifest',
      'authorize',
      'environment',
      'acquire-read',
      'cleanup',
      'dispose',
    ]);
  });

  it('should derive identifiers internally and reject invalid provider ids', async () => {
    const { events, service } = fixture();

    await assert.rejects(
      service.prepareGitHub({
        agentId: 'data',
        cloneUrl: 'https://github.com/tanaabased/openclaw-agent-system.git',
        defaultBranch: 'main',
        itemDatabaseId: 0,
        itemType: 'issue',
        repositoryDatabaseId: 7,
      }),
      /work-item database id must be a positive integer/u,
    );
    assert.deepEqual(events, []);
  });
});
