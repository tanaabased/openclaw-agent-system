import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import GitRepositoryService from '../tools/git/repository-service.ts';
import GitWorktreeService from '../tools/git/worktree-service.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';
import { repositoryFixture } from './git-repository-fixture.ts';

const repositoryId = 'github-10';
const source = 'https://github.com/owner/repo.git';

describe('tools/git/worktree cleanup repository boundary', () => {
  let fixture: Awaited<ReturnType<typeof repositoryFixture>>;
  let service: GitWorktreeService;
  let repositoryPath: string;
  let recordPath: string;

  beforeEach(async () => {
    fixture = await repositoryFixture();
    await mkdir(fixture.layout.worktreeRoot, { recursive: true, mode: 0o700 });
    const repositories = new GitRepositoryService();
    const lease = await repositories.acquire(fixture.context, fixture.layout, repositoryId, source);
    try {
      const repository = await withPrivateStateLock(lease, () =>
        repositories.resolve(fixture.context, fixture.layout, repositoryId, source, false, true),
      );
      repositoryPath = repository.path;
    } finally {
      await lease.release();
    }
    recordPath = join(
      fixture.layout.repositoryRoot,
      gitWorktreeRepositoryDirectoryName(repositoryId) + '.repository.json',
    );
    service = new GitWorktreeService({
      layoutService: {
        async inspect() {
          return {
            layout: fixture.layout,
            gitignored: true,
            tracked: false,
            repositoryRoot: 'ready',
            worktreeRoot: 'ready',
            workingDirectory: 'ready',
            localRepositories: {},
          };
        },
      },
    });
  });

  afterEach(async () => {
    await rm(fixture.workspaceDir, { recursive: true, force: true });
  });

  for (const operation of ['cleanup', 'remove'] as const) {
    const invoke = async () => {
      if (operation === 'remove') {
        await assert.rejects(
          service.remove(fixture.context, repositoryId, 'fixture'),
          /worktree is unavailable/u,
        );
      } else {
        assert.equal(
          (await service.cleanup(fixture.context, repositoryId, 'fixture')).status,
          'missing',
        );
      }
    };

    it(`should not recreate a missing source checkout during ${operation}`, async () => {
      const record = await readFile(recordPath, 'utf8');
      await rm(repositoryPath, { recursive: true });
      fixture.git.calls.length = 0;
      await invoke();
      assert.equal(
        fixture.git.calls.some(({ argv }) => argv[0] === 'clone'),
        false,
      );
      await assert.rejects(lstat(repositoryPath), { code: 'ENOENT' });
      assert.equal(await readFile(recordPath, 'utf8'), record);
    });

    it(`should not rewrite repository preparation state during ${operation}`, async () => {
      await utimes(recordPath, new Date(0), new Date(0));
      const before = await lstat(recordPath);
      fixture.git.calls.length = 0;
      await invoke();
      assert.equal((await lstat(recordPath)).mtimeMs, before.mtimeMs);
      assert.equal(
        fixture.git.calls.some(({ argv }) => ['clone', 'fetch'].includes(argv[0]!)),
        false,
      );
    });
  }

  it('should preserve an orphaned worktree when its source checkout is missing', async () => {
    const missing = await service.cleanup(fixture.context, repositoryId, 'fixture');
    await mkdir(missing.path, { recursive: true });
    await rm(repositoryPath, { recursive: true });
    fixture.git.calls.length = 0;
    assert.equal(
      (await service.cleanup(fixture.context, repositoryId, 'fixture')).status,
      'unsafe',
    );
    assert.equal((await lstat(missing.path)).isDirectory(), true);
    assert.equal(
      fixture.git.calls.some(({ argv }) => argv[0] === 'clone'),
      false,
    );
  });
});
