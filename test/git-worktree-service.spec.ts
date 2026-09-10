import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import acquirePrivateStateFileLock, {
  privateStateFileLockBusyErrorCode,
} from '../core/private-state-file-lock.ts';
import GitWorktreeService, { type GitWorktreeGitRunner } from '../tools/git/worktree-service.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';

interface FakeWorktree {
  branch: string;
  repository: string;
}

class FakeGitRunner implements GitWorktreeGitRunner {
  beforeRun?: (input: Parameters<GitWorktreeGitRunner['run']>[0]) => Promise<void>;
  readonly branches = new Set<string>();
  readonly calls: Array<{ argv: string[]; cwd: string }> = [];
  readonly identities = new Map<string, string>();
  readonly origins = new Map<string, string>();
  dirty = false;
  fetchFails = false;
  removeFails = false;
  readonly worktrees = new Map<string, FakeWorktree>();

  async run(input: { argv: string[]; cwd: string }) {
    this.calls.push({ argv: input.argv, cwd: input.cwd });
    await this.beforeRun?.(input);
    const [command, ...argv] = input.argv;
    if (command === 'rev-parse' && argv[0] === '--git-common-dir') {
      return { exitCode: 0, stderr: '', stdout: '.git\n' };
    }
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
    if (command === 'remote' && argv[0] === 'set-url') {
      this.origins.set(input.cwd, argv[2] ?? '');
    }
    if (command === 'fetch' && this.fetchFails) {
      return { exitCode: 1, stderr: 'fetch failed', stdout: '' };
    }
    if (command === 'show-ref') {
      const branch = argv.at(-1)?.replace(/^refs\/heads\//u, '');
      return {
        exitCode: [...this.worktrees.values()].some((entry) => entry.branch === branch) ? 0 : 1,
        stderr: '',
        stdout: '',
      };
    }
    if (command === 'status') {
      return { exitCode: 0, stderr: '', stdout: this.dirty ? ' M tracked.txt\n' : '' };
    }
    if (command === 'worktree' && argv[0] === 'add') {
      const createsBranch = argv[1] === '-b';
      const branch = createsBranch ? (argv[2] ?? '') : (argv.at(-1) ?? '');
      const path = createsBranch ? (argv[3] ?? '') : (argv[1] ?? '');
      await mkdir(path, { recursive: true });
      this.branches.add(branch);
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

function observeContention(notify: () => void): typeof acquirePrivateStateFileLock {
  return async (path, options) => {
    try {
      return await acquirePrivateStateFileLock(path, options);
    } catch (error) {
      if ((error as { code?: string }).code === privateStateFileLockBusyErrorCode) notify();
      throw error;
    }
  };
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
  const createService = (acquireFileLock = acquirePrivateStateFileLock) =>
    new GitWorktreeService({
      acquireFileLock,
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
    createService,
    git,
    repositoryRoot,
    service: createService(),
    workspaceDir,
  };
}

describe('tools/git/worktree-service', () => {
  it('should serialize first clone and reuse across services while another repository proceeds', async () => {
    const { context, createService, git, service, workspaceDir } = await fixture();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const contended = Promise.withResolvers<void>();
    const preparations: Promise<unknown>[] = [];
    const input = {
      baseRef: 'origin/main',
      cloneUrl: 'https://example.com/owner/repository.git',
      repositoryId: 'shared',
      workId: 'first',
    };
    git.beforeRun = async ({ argv }) => {
      if (argv[0] === 'clone' && argv.at(-2) === input.cloneUrl) {
        entered.resolve();
        await held.promise;
      }
    };
    try {
      const first = service.prepare(context, input);
      preparations.push(first);
      await entered.promise;
      const second = createService(observeContention(contended.resolve)).prepare(context, input);
      preparations.push(second);
      await contended.promise;
      assert.equal(git.calls.length, 1);
      const unrelated = await service.prepare(context, {
        ...input,
        cloneUrl: 'https://example.com/owner/other.git',
        repositoryId: 'unrelated',
      });
      assert.equal(unrelated.status, 'created');
      held.resolve();
      const results = await Promise.all([first, second]);
      assert.deepEqual(
        results.map(({ status }) => status),
        ['created', 'existing'],
      );
      assert.equal(results[0]?.path, results[1]?.path);
      assert.equal(git.calls.filter(({ argv }) => argv[0] === 'clone').length, 2);
      assert.equal(
        git.calls.filter(({ argv }) => argv[0] === 'worktree' && argv[1] === 'add').length,
        2,
      );
    } finally {
      held.resolve();
      await Promise.allSettled(preparations);
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  for (const boundary of ['fetch', 'worktree add', 'origin rollback']) {
    it(`should keep shared preparation serialized through ${boundary}`, async () => {
      const { context, createService, git, service, workspaceDir } = await fixture();
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const contended = Promise.withResolvers<void>();
      const preparations: Promise<unknown>[] = [];
      const input = {
        baseRef: 'origin/main',
        cloneUrl: 'https://example.com/owner/repository.git',
        repositoryId: 'shared',
      };
      try {
        await service.prepare(context, { ...input, workId: 'seed' });
        let intercepted = false;
        git.beforeRun = async ({ argv }) => {
          const command = boundary === 'worktree add' ? argv.slice(0, 2).join(' ') : argv[0];
          if (!intercepted && command === (boundary === 'origin rollback' ? 'fetch' : boundary)) {
            intercepted = true;
            entered.resolve();
            await held.promise;
            if (boundary === 'origin rollback') throw new Error('fetch failed');
          }
        };
        const first = service.prepare(context, {
          ...input,
          ...(boundary === 'origin rollback'
            ? {
                cloneUrl: 'https://example.com/owner/renamed.git',
                reconcileOrigin: true,
              }
            : {}),
          workId: 'first',
        });
        const checkedFirst =
          boundary === 'origin rollback'
            ? assert.rejects(first, /origin could not be reconciled/u)
            : first;
        preparations.push(checkedFirst);
        await entered.promise;
        const callsWhileHeld = git.calls.length;
        const second = createService(observeContention(contended.resolve)).prepare(context, {
          ...input,
          workId: 'second',
        });
        preparations.push(second);
        await contended.promise;
        assert.equal(git.calls.length, callsWhileHeld);
        held.resolve();
        await checkedFirst;
        assert.equal((await second).status, 'created');
        assert.equal(git.worktrees.size, boundary === 'origin rollback' ? 2 : 3);
      } finally {
        held.resolve();
        await Promise.allSettled(preparations);
        await rm(workspaceDir, { force: true, recursive: true });
      }
    });
  }

  it('should cancel a waiting preparation without releasing its live owner', async () => {
    const { context, createService, git, service, workspaceDir } = await fixture();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const contended = Promise.withResolvers<void>();
    const controller = new AbortController();
    const preparations: Promise<unknown>[] = [];
    const input = {
      baseRef: 'origin/main',
      cloneUrl: 'https://example.com/owner/repository.git',
      repositoryId: 'shared',
      workId: 'first',
    };
    git.beforeRun = async ({ argv }) => {
      if (argv[0] === 'clone') {
        entered.resolve();
        await held.promise;
      }
    };
    try {
      const first = service.prepare(context, input);
      preparations.push(first);
      await entered.promise;
      const waiter = createService(observeContention(contended.resolve));
      const cancelled = assert.rejects(
        waiter.prepare({ ...context, signal: controller.signal }, input),
        /cancelled/u,
      );
      preparations.push(cancelled);
      await contended.promise;
      controller.abort(new Error('cancelled'));
      await cancelled;
      const stillContended = Promise.withResolvers<void>();
      const next = createService(observeContention(stillContended.resolve)).prepare(context, input);
      preparations.push(next);
      await stillContended.promise;
      assert.equal(git.calls.length, 1);
      held.resolve();
      assert.equal((await first).status, 'created');
      assert.equal((await next).status, 'existing');
    } finally {
      held.resolve();
      controller.abort();
      await Promise.allSettled(preparations);
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should release preparation after cancellation during acquisition and after clone failure', async () => {
    const { context, createService, git, service, workspaceDir } = await fixture();
    const controller = new AbortController();
    const input = {
      baseRef: 'origin/main',
      cloneUrl: 'https://example.com/owner/repository.git',
      repositoryId: 'shared',
      workId: 'first',
    };
    try {
      const cancelled = createService(async (path, options) => {
        const lease = await acquirePrivateStateFileLock(path, options);
        controller.abort(new Error('cancelled'));
        return lease;
      });
      await assert.rejects(
        cancelled.prepare({ ...context, signal: controller.signal }, input),
        /cancelled/u,
      );
      assert.equal(git.calls.length, 0);
      git.beforeRun = async () => {
        throw new Error('clone failed');
      };
      await assert.rejects(service.prepare(context, input), /clone failed/u);
      git.beforeRun = undefined;
      assert.equal((await service.prepare(context, input)).status, 'created');
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should prepare, reuse, list, and remove a deterministic managed worktree', async () => {
    const { context, git, repositoryRoot, service, workspaceDir } = await fixture();
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
      assert.equal(git.branches.has(prepared.branch), true);
      assert.equal(
        (
          await lstat(join(repositoryRoot, gitWorktreeRepositoryDirectoryName(input.repositoryId)))
        ).isDirectory(),
        true,
      );
      assert.equal(git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
      assert.equal(git.calls.filter(({ argv }) => argv[0] === 'fetch').length, 0);
      assert.equal(
        git.calls.some(({ argv }) => argv[0] === 'worktree' && argv.includes('--force')),
        false,
      );
      assert.deepEqual(
        git.calls.filter(({ argv }) => argv[0] === 'worktree' && argv[1] === 'remove').at(-1)?.argv,
        ['worktree', 'remove', prepared.path],
      );
      assert.equal(
        git.calls.some(({ argv }) => ['branch', 'reflog', 'update-ref'].includes(argv[0] ?? '')),
        false,
      );
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should return an empty list for a managed repository that does not exist yet', async () => {
    const { context, git, service, workspaceDir } = await fixture();
    try {
      assert.deepEqual(await service.list(context, 'missing'), []);
      assert.deepEqual(git.calls, []);
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
      assert.equal(git.branches.size, 1);
      assert.equal(git.worktrees.size, 1);
      await assert.rejects(
        service.remove(context, 'repository', 'missing'),
        /worktree is unavailable/u,
      );
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should remove only a clean deterministic worktree during lifecycle cleanup', async () => {
    const { context, git, service, workspaceDir } = await fixture();
    try {
      const input = {
        baseRef: 'main',
        cloneUrl: 'https://example.com/one.git',
        repositoryId: 'repository',
        workId: 'one',
      };
      await service.prepare(context, input);
      git.dirty = true;
      assert.equal(
        (await service.cleanup(context, input.repositoryId, input.workId)).status,
        'dirty',
      );
      assert.equal(git.worktrees.size, 1);
      git.dirty = false;
      assert.equal(
        (await service.cleanup(context, input.repositoryId, input.workId)).status,
        'removed',
      );
      assert.equal(
        (await service.cleanup(context, input.repositoryId, input.workId)).status,
        'missing',
      );
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should reconcile a trusted managed origin without disturbing existing worktrees', async () => {
    const { context, git, repositoryRoot, service, workspaceDir } = await fixture();
    try {
      const repositoryId = 'github-7';
      const oldOrigin = 'git@github.com:tanaabased/old-name.git';
      const newOrigin = 'git@github.com:tanaabased/new-name.git';
      const first = await service.prepare(context, {
        baseRef: 'origin/main',
        cloneUrl: oldOrigin,
        repositoryId,
        workId: 'first',
      });

      const second = await service.prepare(context, {
        baseRef: 'origin/main',
        cloneUrl: newOrigin,
        reconcileOrigin: true,
        repositoryId,
        workId: 'second',
      });

      const managedRepository = join(
        repositoryRoot,
        gitWorktreeRepositoryDirectoryName(repositoryId),
      );
      assert.equal(git.origins.get(managedRepository), newOrigin);
      assert.equal(git.worktrees.has(first.path), true);
      assert.equal(git.worktrees.has(second.path), true);
      assert.equal(git.calls.filter(({ argv }) => argv[0] === 'fetch').length, 1);
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should restore a managed origin when trusted reconciliation cannot fetch', async () => {
    const { context, git, repositoryRoot, service, workspaceDir } = await fixture();
    try {
      const repositoryId = 'github-7';
      const oldOrigin = 'git@github.com:tanaabased/old-name.git';
      await service.prepare(context, {
        baseRef: 'origin/main',
        cloneUrl: oldOrigin,
        repositoryId,
        workId: 'first',
      });
      git.fetchFails = true;

      await assert.rejects(
        service.prepare(context, {
          baseRef: 'origin/main',
          cloneUrl: 'git@github.com:tanaabased/new-name.git',
          reconcileOrigin: true,
          repositoryId,
          workId: 'second',
        }),
        /origin could not be reconciled/u,
      );

      assert.equal(
        git.origins.get(join(repositoryRoot, gitWorktreeRepositoryDirectoryName(repositoryId))),
        oldOrigin,
      );
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it('should use a configured local repository without cloning it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-worktree-local-'));
    const local = join(root, 'repository');
    await mkdir(join(local, '.git'), { recursive: true });
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

  it('should serialize local repository aliases across workspace roots', async () => {
    const local = await realpath(await mkdtemp(join(tmpdir(), 'agent-system-shared-local-')));
    await mkdir(join(local, '.git'));
    const firstFixture = await fixture({ first: local });
    const secondFixture = await fixture({ second: local });
    const { git } = firstFixture;
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const contended = Promise.withResolvers<void>();
    const preparations: Promise<unknown>[] = [];
    git.beforeRun = async ({ argv }) => {
      if (argv[0] === 'worktree' && argv[1] === 'add') {
        entered.resolve();
        await held.promise;
      }
    };
    try {
      const first = firstFixture.service.prepare(firstFixture.context, {
        baseRef: 'main',
        repositoryId: 'first',
        workId: 'task',
      });
      preparations.push(first);
      await entered.promise;
      const second = secondFixture
        .createService(observeContention(contended.resolve))
        .prepare(
          { ...secondFixture.context, git },
          { baseRef: 'main', repositoryId: 'second', workId: 'task' },
        );
      preparations.push(second);
      await contended.promise;
      assert.equal(
        git.calls.filter(({ argv }) => argv[0] === 'worktree' && argv[1] === 'add').length,
        1,
      );
      held.resolve();
      assert.equal((await first).status, 'created');
      assert.equal((await second).status, 'created');
      assert.equal(git.worktrees.size, 2);
    } finally {
      held.resolve();
      await Promise.allSettled(preparations);
      await Promise.all([
        rm(firstFixture.workspaceDir, { force: true, recursive: true }),
        rm(secondFixture.workspaceDir, { force: true, recursive: true }),
        rm(local, { force: true, recursive: true }),
      ]);
    }
  });
});
