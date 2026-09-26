import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import createGitLifecycleContribution from '../tools/git/lifecycle.ts';

describe('tools/git/lifecycle', () => {
  it('should accept identity inherited from the agent section', () => {
    const contribution = createGitLifecycleContribution();

    assert.deepEqual(
      contribution.validate?.({
        manifest: {
          schemaVersion: 1,
          agent: { id: 'data', email: 'data@example.com', name: 'Data' },
          git: {},
        },
        workspaceDir: '/workspace',
      }),
      {
        code: 'git-config-valid',
        summary: 'Git tool identity and policy configuration',
      },
    );
  });

  it('should require declared identity', () => {
    const contribution = createGitLifecycleContribution();
    const result = contribution.validate?.({
      manifest: {
        schemaVersion: 1,
        agent: { id: 'data' },
        git: {},
      },
      workspaceDir: '/workspace',
    });

    assert.deepEqual(
      result?.diagnostics?.map(({ code, severity }) => ({ code, severity })),
      [
        { code: 'git-name-required', severity: 'error' },
        { code: 'git-email-required', severity: 'error' },
      ],
    );
  });

  it('should leave openssh availability to the shared tool checker', async () => {
    const contribution = createGitLifecycleContribution({
      sshResourceService: {
        async acquire() {
          throw new Error('not called');
        },
      },
    });

    assert.deepEqual(
      await contribution.inspect?.({
        manifest: {
          schemaVersion: 1,
          agent: { id: 'data', email: 'data@example.com', name: 'Data' },
          git: {},
        },
        workspaceDir: '/workspace',
      }),
      [],
    );
    assert.deepEqual(
      await contribution.inspect?.({
        manifest: {
          schemaVersion: 1,
          agent: { id: 'data', email: 'data@example.com', name: 'Data' },
          git: {
            ssh: { privateKeys: [{ fromEnvironment: 'GIT_SSH_PRIVATE_KEY' }] },
          },
        },
        workspaceDir: '/workspace',
      }),
      [],
    );
  });

  it('should inspect and reconcile managed worktree roots only when configured', async () => {
    const calls: string[] = [];
    const layout = {
      ignoreEntries: ['/.agent-system/repositories/', '/.agent-system/worktrees/'],
      localRepositories: { canon: '/repos/canon' },
      repositoryRoot: '/workspace/.agent-system/repositories',
      worktreeRoot: '/workspace/.agent-system/worktrees',
      workspaceDir: '/workspace',
    };
    const contribution = createGitLifecycleContribution({
      worktreeLayoutService: {
        async inspect() {
          calls.push('inspect');
          return {
            gitignored: true,
            layout,
            localRepositories: { canon: 'ready' as const },
            repositoryRoot: 'ready' as const,
            tracked: false,
            worktreeRoot: 'ready' as const,
          };
        },
        async reconcile() {
          calls.push('reconcile');
          return {
            actions: ['create-repository-root' as const, 'create-worktree-root' as const],
            gitignored: true,
            layout,
            localRepositories: { canon: 'ready' as const },
            repositoryRoot: 'ready' as const,
            tracked: false,
            worktreeRoot: 'ready' as const,
          };
        },
      },
    });
    const context = {
      manifest: {
        schemaVersion: 1 as const,
        agent: { id: 'data', email: 'data@example.com', name: 'Data' },
        git: { worktrees: { repositories: { local: { canon: '/repos/canon' } } } },
      },
      workspaceDir: '/workspace',
    };

    assert.deepEqual(await contribution.inspect?.(context), [
      {
        code: 'git-repositories-root-ready',
        message: 'Git managed repositories root is ready.',
        status: 'healthy',
      },
      {
        code: 'git-worktrees-root-ready',
        message: 'Git managed worktrees root is ready.',
        status: 'healthy',
      },
      {
        code: 'git-worktree-roots-gitignored',
        message: 'Git managed repository and worktree roots are ignored.',
        status: 'healthy',
      },
      {
        code: 'git-worktree-local-repository-ready',
        message: 'Git local repository override canon is ready.',
        status: 'healthy',
      },
    ]);
    assert.deepEqual(await contribution.reconcile?.(context), {
      outcomes: [
        {
          code: 'git-worktrees-create-repository-root',
          message: 'Git managed repository root',
          status: 'created',
        },
        {
          code: 'git-worktrees-create-worktree-root',
          message: 'Git managed worktree root',
          status: 'created',
        },
      ],
    });
    assert.deepEqual(calls, ['inspect', 'reconcile']);
  });

  it('should inspect signing dependencies and the public trust file without credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-git-lifecycle-'));
    const workspaceDir = join(root, 'workspace');
    await mkdir(join(workspaceDir, '.agent-system'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.agent-system', 'allowed_signers'),
      'data@example.com ssh-ed25519 AAAA\n',
    );
    const contribution = createGitLifecycleContribution({
      sshResourceService: {
        async acquire() {
          throw new Error('not called');
        },
      },
    });

    try {
      assert.deepEqual(
        await contribution.inspect?.({
          manifest: {
            schemaVersion: 1,
            agent: { id: 'data', email: 'data@example.com', name: 'Data' },
            git: {
              signing: {
                allowedSignersFile: '.agent-system/allowed_signers',
                key: 'GIT_SIGNING_KEY',
              },
            },
          },
          workspaceDir,
        }),
        [
          {
            code: 'git-signing-allowed-signers-ready',
            message: 'Git SSH allowed signers file is available.',
            status: 'healthy',
          },
        ],
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
