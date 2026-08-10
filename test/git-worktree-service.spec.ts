import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import GitWorktreeService, { type GitWorktreeGitRunner } from '../tools/git/worktree-service.ts';

interface FakeWorktree {
  branch: string;
  repository: string;
}

class FakeGitRunner implements GitWorktreeGitRunner {
  readonly calls: Array<{ argv: string[]; cwd: string }> = [];
  readonly identities = new Map<string, string>();
  readonly origins = new Map<string, string>();
  removeFails = false;
  readonly worktrees = new Map<string, FakeWorktree>();

  async run(input: { argv: string[]; cwd: string }) {
    this.calls.push({ argv: input.argv, cwd: input.cwd });
    const [command, ...argv] = input.argv;
    if (command === 'clone') {
      const source = argv.at(-2) ?? '';
      const path = argv.at(-1) ?? '';
      await mkdir(path, { recursive: true });
      this.origins.set(path, source);
    }
    if (command === 'config' && argv[0] === 'agent-system.repository-id') {
      this.identities.set(input.cwd, argv[1] ?? '');
    }
    if (command === 'config' && argv[0] === '--get') {
      const value =
        this.identities.get(input.cwd) ??
        [...this.identities].find(([path]) => path.startsWith(`${input.cwd}.`))?.[1];
      return { exitCode: value ? 0 : 1, stderr: '', stdout: value ? `${value}\n` : '' };
    }
    if (command === 'remote' && argv[0] === 'get-url') {
      const value =
        this.origins.get(input.cwd) ??
        [...this.origins].find(([path]) => path.startsWith(`${input.cwd}.`))?.[1];
      return { exitCode: value ? 0 : 1, stderr: '', stdout: value ? `${value}\n` : '' };
    }
    if (command === 'show-ref') {
      const branch = argv.at(-1)?.replace(/^refs\/heads\//u, '');
      return {
        exitCode: [...this.worktrees.values()].some((entry) => entry.branch === branch) ? 0 : 1,
        stderr: '',
        stdout: '',
      };
    }
    if (command === 'worktree' && argv[0] === 'add') {
      const createsBranch = argv[1] === '-b';
      const branch = createsBranch ? (argv[2] ?? '') : (argv.at(-1) ?? '');
      const path = createsBranch ? (argv[3] ?? '') : (argv[1] ?? '');
      await mkdir(path, { recursive: true });
      this.worktrees.set(path, { branch, repository: input.cwd });
    }
    if (command === 'worktree' && argv[0] === 'remove') {
      if (this.removeFails) return { exitCode: 1, stderr: 'contains modified files', stdout: '' };
      const path = argv[1] ?? '';
      this.worktrees.delete(path);
      await rm(path, { force: true, recursive: true });
    }
    if (command === 'worktree' && argv[0] === 'list') {
      const entries = [...this.worktrees.entries()]
        .filter(([, entry]) => entry.repository === input.cwd)
        .map(([path, entry]) => `worktree ${path}\nbranch refs/heads/${entry.branch}\n`);
      return { exitCode: 0, stderr: '', stdout: entries.join('\n') };
    }
    return { exitCode: 0, stderr: '', stdout: '' };
  }
}

async function fixture(localRepositories: Record<string, string> = {}) {
  const workspaceDir = await realpath(
    await mkdtemp(join(tmpdir(), 'agent-system-worktree-service-')),
  );
  const repositoryRoot = join(workspaceDir, '.agent-system', 'repositories');
  const worktreeRoot = join(workspaceDir, '.agent-system', 'worktrees');
  await Promise.all([
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(worktreeRoot, { recursive: true }),
  ]);
  const git = new FakeGitRunner();
  const service = new GitWorktreeService({
    layoutService: {
      async inspect() {
        return {
          gitignored: true,
          layout: {
            ignoreEntries: [],
            localRepositories,
            repositoryRoot,
            workspaceDir,
            worktreeRoot,
          },
          localRepositories: Object.fromEntries(
            Object.keys(localRepositories).map((id) => [id, 'ready' as const]),
          ),
          repositoryRoot: 'ready' as const,
          tracked: false,
          worktreeRoot: 'ready' as const,
        };
      },
    },
  });
  return {
    context: { configuration: {}, git, workspaceDir },
    git,
    service,
    workspaceDir,
  };
}

describe('tools/git/worktree-service', () => {
  it('should prepare, reuse, list, and remove a deterministic managed worktree', async () => {
    const { context, git, service, workspaceDir } = await fixture();
    try {
      const input = {
        baseRef: 'origin/main',
        cloneUrl: 'https://example.com/owner/repository.git',
        repositoryId: 'owner/repository',
        workId: '123-fix-agent-path-resolution',
      };

      const prepared = await service.prepare(context, input);
      assert.equal(prepared.status, 'created');
      assert.equal(prepared.branch, basename(prepared.path));
      assert.match(prepared.branch, /^123-fix-agent-path-resolution-[a-f0-9]{10}$/u);
      assert.equal((await service.prepare(context, input)).status, 'existing');
      assert.deepEqual(await service.list(context, input.repositoryId), [
        {
          branch: prepared.branch,
          path: prepared.path,
          repositoryId: prepared.repositoryId,
          status: 'active',
        },
      ]);
      assert.equal(
        (await service.remove(context, input.repositoryId, input.workId)).status,
        'removed',
      );
      assert.deepEqual(await service.list(context, input.repositoryId), []);
      assert.equal(git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
      assert.equal(git.calls.filter(({ argv }) => argv[0] === 'fetch').length, 0);
      assert.equal(
        git.calls.some(({ argv }) => argv[0] === 'worktree' && argv.includes('--force')),
        false,
      );
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should refresh an existing managed repository only before creating another worktree', async () => {
    const { context, git, service, workspaceDir } = await fixture();
    try {
      const input = {
        baseRef: 'origin/main',
        cloneUrl: 'https://example.com/owner/repository.git',
        repositoryId: 'owner/repository',
      };

      await service.prepare(context, { ...input, workId: 'first' });
      git.calls.length = 0;
      await service.prepare(context, { ...input, workId: 'second' });

      const fetches = git.calls.filter(({ argv }) => argv[0] === 'fetch');
      assert.equal(fetches.length, 1);
      assert.deepEqual(fetches[0]?.argv, [
        'fetch',
        'origin',
        '+refs/heads/*:refs/remotes/origin/*',
      ]);
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should preserve managed repository provenance and let git refuse unsafe removal', async () => {
    const { context, git, service, workspaceDir } = await fixture();
    try {
      await service.prepare(context, {
        baseRef: 'main',
        cloneUrl: 'https://example.com/one.git',
        repositoryId: 'repository',
        workId: 'one',
      });
      await assert.rejects(
        service.prepare(context, {
          baseRef: 'main',
          cloneUrl: 'https://example.com/two.git',
          repositoryId: 'repository',
          workId: 'two',
        }),
        /another origin/u,
      );

      git.removeFails = true;
      await assert.rejects(service.remove(context, 'repository', 'one'), /removal failed/u);
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should use a configured local repository without cloning it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-worktree-local-'));
    const local = join(root, 'repository');
    await mkdir(local);
    const { context, git, service, workspaceDir } = await fixture({ local });
    try {
      const result = await service.prepare(context, {
        baseRef: 'main',
        repositoryId: 'local',
        workId: 'task',
      });

      assert.equal(result.status, 'created');
      assert.equal(
        git.calls.some(({ argv }) => argv[0] === 'clone'),
        false,
      );
      assert.equal(
        git.calls.some(({ argv }) => argv[0] === 'fetch'),
        false,
      );
      assert.equal(
        git.calls.some(({ argv, cwd }) => argv[0] === 'worktree' && cwd === local),
        true,
      );
    } finally {
      await Promise.all([
        rm(workspaceDir, { force: true, recursive: true }),
        rm(root, { force: true, recursive: true }),
      ]);
    }
  });
});
