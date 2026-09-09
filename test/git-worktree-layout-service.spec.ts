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

  it('should reject symlinked managed roots and missing local overrides', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-worktree-layout-'));
    const outside = await mkdtemp(join(tmpdir(), 'agent-system-worktree-outside-'));
    await mkdir(join(workspaceDir, '.agent-system'), { recursive: true });
    await symlink(outside, join(workspaceDir, '.agent-system', 'worktrees'));
    const service = new GitWorktreeLayoutService({ currentUid: process.getuid?.(), runCli });

    await assert.rejects(service.reconcile(workspaceDir, {}), /unavailable or unsafe/u);
    await assert.rejects(
      service.reconcile(workspaceDir, {
        root: '.worktrees',
        repositories: { root: '.repositories', local: { missing: './missing' } },
      }),
      /local repository overrides/u,
    );
  });
});
