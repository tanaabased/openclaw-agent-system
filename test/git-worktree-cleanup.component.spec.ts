import { codexStoragePaths } from '../agent/storage/codex-storage.ts';
import { bindSqliteInstallation } from '../agent/storage/agent-database.ts';
import assert from 'node:assert/strict';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import GitRepositoryService from '../tools/git/repository-service.ts';
import GitWorktreeService from '../tools/git/worktree-service.ts';
import { DatabaseSync } from 'node:sqlite';
import { repositoryFixture } from './git-repository-fixture.ts';

const repositoryId = 'github-10';
const source = 'https://github.com/owner/repo.git';

describe('tools/git/worktree cleanup repository boundary', () => {
  let fixture: Awaited<ReturnType<typeof repositoryFixture>>;
  let service: GitWorktreeService;
  let repositoryPath: string;
  let db: ReturnType<typeof bindSqliteInstallation>;

  beforeEach(async () => {
    fixture = await repositoryFixture();
    const location = codexStoragePaths(fixture.workspaceDir);
    db = bindSqliteInstallation(location);
    await db.install();
    await mkdir(fixture.layout.worktreeRoot, { recursive: true, mode: 0o700 });
    const repositories = new GitRepositoryService({ sqliteInstallation: location });
    const lease = await repositories.acquire(fixture.context, fixture.layout, repositoryId, source);
    try {
      const repository = await withPrivateStateLock(lease, () =>
        repositories.resolve(fixture.context, fixture.layout, repositoryId, source, false, true),
      );
      repositoryPath = repository.path;
    } finally {
      await lease.release();
    }
    service = new GitWorktreeService({
      sqliteInstallation: location,
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
      const record = await db.readRepository(fixture.layout.repositoryRoot, repositoryId);
      await rm(repositoryPath, { recursive: true });
      fixture.git.calls.length = 0;
      await invoke();
      assert.equal(
        fixture.git.calls.some(({ argv }) => argv[0] === 'clone'),
        false,
      );
      await assert.rejects(lstat(repositoryPath), { code: 'ENOENT' });
      assert.deepEqual(
        await db.readRepository(fixture.layout.repositoryRoot, repositoryId),
        record,
      );
    });

    it(`should not rewrite repository preparation state during ${operation}`, async () => {
      using observer = new DatabaseSync(
        join(codexStoragePaths(fixture.workspaceDir).installationRoot, 'agent-system.sqlite'),
        { readOnly: true },
      );
      const version = observer.prepare('PRAGMA data_version');
      const before = version.get();
      fixture.git.calls.length = 0;
      await invoke();
      assert.deepEqual(version.get(), before);
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
