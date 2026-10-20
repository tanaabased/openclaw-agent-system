import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSystemCliRunner } from '../api/types.ts';
import GitWorktreeLayoutService from '../tools/git/worktree-layout-service.ts';

const runCli: AgentSystemCliRunner = async () => ({
  exitCode: 1,
  stderr: 'not a git repository',
  stdout: '',
  timedOut: false,
  truncated: false,
});

describe('tools/git/worktree-layout-service', () => {
  it('should inspect a missing working directory without creating it and preserve existing permissions', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-worktree-layout-'));
    const configuration = { repositories: { workingDirectory: 'checkouts' } };
    const service = new GitWorktreeLayoutService({ currentUid: process.getuid?.(), runCli });
    assert.equal((await service.inspect(workspaceDir, configuration)).workingDirectory, 'missing');
    await assert.rejects(lstat(join(workspaceDir, 'checkouts')), { code: 'ENOENT' });
    const first = await service.reconcile(workspaceDir, configuration);
    assert.ok(first.actions.includes('create-working-directory'));
    assert.equal(first.workingDirectory, 'ready');
    await chmod(join(workspaceDir, 'checkouts'), 0o755);
    assert.deepEqual((await service.reconcile(workspaceDir, configuration)).actions, []);
    assert.equal((await lstat(join(workspaceDir, 'checkouts'))).mode & 0o777, 0o755);
    await chmod(join(workspaceDir, 'checkouts'), 0o777);
    assert.equal((await service.inspect(workspaceDir, configuration)).workingDirectory, 'unsafe');
    await assert.rejects(service.reconcile(workspaceDir, configuration), /unsafe/u);
    assert.equal((await lstat(join(workspaceDir, 'checkouts'))).mode & 0o777, 0o777);
  });
  it('should reconcile ignored owner-only managed roots idempotently', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-worktree-layout-'));
    const service = new GitWorktreeLayoutService({ currentUid: process.getuid?.(), runCli });

    const first = await service.reconcile(workspaceDir, {});
    const second = await service.reconcile(workspaceDir, {});

    assert.deepEqual(first.actions, [
      'update-gitignore',
      'create-repository-root',
      'create-worktree-root',
    ]);
    assert.deepEqual(second.actions, []);
    assert.equal((await lstat(first.layout.repositoryRoot)).mode & 0o777, 0o700);
    assert.equal((await lstat(first.layout.worktreeRoot)).mode & 0o777, 0o700);
    assert.match(await readFile(join(workspaceDir, '.gitignore'), 'utf8'), /worktrees\//u);

    await chmod(first.layout.worktreeRoot, 0o755);
    assert.equal((await service.inspect(workspaceDir, {})).worktreeRoot, 'unsafe');
  });

  it('should reject symlinked managed roots', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-worktree-layout-'));
    const outside = await mkdtemp(join(tmpdir(), 'agent-system-worktree-outside-'));
    await mkdir(join(workspaceDir, '.agent-system'), { recursive: true });
    await symlink(outside, join(workspaceDir, '.agent-system', 'worktrees'));
    const service = new GitWorktreeLayoutService({ currentUid: process.getuid?.(), runCli });

    await assert.rejects(service.reconcile(workspaceDir, {}), /unavailable or unsafe/u);
  });

  it('should preserve missing local overrides as drift', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-worktree-layout-'));
    const configuration = {
      root: '.worktrees',
      repositories: { root: '.repositories', local: { missing: './missing' } },
    };
    const service = new GitWorktreeLayoutService({ currentUid: process.getuid?.(), runCli });

    const first = await service.reconcile(workspaceDir, configuration);
    const second = await service.reconcile(workspaceDir, configuration);

    assert.deepEqual(first.actions, [
      'update-gitignore',
      'create-repository-root',
      'create-worktree-root',
    ]);
    assert.deepEqual(first.localRepositories, { missing: 'missing' });
    assert.deepEqual(second.actions, []);
    assert.deepEqual(second.localRepositories, { missing: 'missing' });
  });

  it('should reject non-repository and symlinked local overrides', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-worktree-layout-'));
    const localRepository = await mkdtemp(join(tmpdir(), 'agent-system-worktree-local-'));
    const symlinkPath = join(await mkdtemp(join(tmpdir(), 'agent-system-worktree-link-')), 'repo');
    await symlink(localRepository, symlinkPath);
    const service = new GitWorktreeLayoutService({ currentUid: process.getuid?.(), runCli });

    for (const path of [localRepository, symlinkPath]) {
      await assert.rejects(
        service.reconcile(workspaceDir, {
          root: '.worktrees',
          repositories: { root: '.repositories', local: { unsafe: path } },
        }),
        /local repository overrides are unsafe/u,
      );
    }
  });
});
