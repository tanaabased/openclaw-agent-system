import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import GitRepositoryService, {
  RepositoryPreparationError,
} from '../tools/git/repository-service.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';
import { repositoryFixture } from './git-repository-fixture.ts';

const source = 'https://github.com/owner/repo.git';
const id = 'github-10';

describe('tools/git/repository-service', () => {
  let fixture: Awaited<ReturnType<typeof repositoryFixture>>;
  beforeEach(async () => {
    fixture = await repositoryFixture();
  });
  afterEach(async () => {
    await rm(fixture.workspaceDir, { recursive: true, force: true });
  });
  const prepare = async (repositoryId = id, remote = source) => {
    const service = new GitRepositoryService();
    const lease = await service.acquire(fixture.context, fixture.layout, repositoryId, remote);
    try {
      return await withPrivateStateLock(lease, () =>
        service.resolve(fixture.context, fixture.layout, repositoryId, remote, false, true),
      );
    } finally {
      await lease.release();
    }
  };

  it('should clone once at the configured name and recover through a new service', async () => {
    const first = await prepare();
    assert.equal(first.path, join(fixture.layout.workingDirectory!, 'repo'));
    const again = await prepare();
    assert.equal(again.path, first.path);
    assert.equal(fixture.git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
    assert.equal(
      fixture.git.calls.find(({ argv }) => argv[0] === 'clone')!.argv.includes('--bare'),
      false,
    );
    assert.equal(
      (await new GitRepositoryService().workingRepositories(fixture.context, fixture.layout))[0]!
        .path,
      first.path,
    );
  });

  it('should preserve an existing dirty checkout and prefer explicit mappings', async () => {
    const path = join(fixture.workspaceDir, 'explicit');
    await fixture.git.seed(path, 'git@github.com:Owner/Repo.git');
    await writeFile(join(path, 'user-work'), 'uncommitted');
    fixture.layout.localRepositories[id] = path;
    assert.equal((await prepare()).path, path);
    assert.equal(await readFile(join(path, 'user-work'), 'utf8'), 'uncommitted');
    assert.equal(
      fixture.git.calls.some(({ argv }) =>
        ['clone', 'checkout', 'reset', 'clean', 'config'].includes(argv[0]!),
      ),
      false,
    );
    await rm(path, { recursive: true });
    await assert.rejects(prepare());
    assert.equal(
      fixture.git.calls.some(({ argv }) => argv[0] === 'clone'),
      false,
    );
  });

  it('should block same-name identities without changing origin or storage', async () => {
    const first = await prepare();
    await assert.rejects(
      prepare('github-11', 'https://github.com/another/repo.git'),
      (error: unknown) =>
        error instanceof RepositoryPreparationError &&
        error.code === 'repository-identity-conflict' &&
        error.path === first.path,
    );
    assert.equal(fixture.git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
    assert.equal(
      fixture.git.calls.some(({ argv }) => argv.includes('set-url')),
      false,
    );
  });

  it('should serialize different repository ids targeting the same checkout', async () => {
    let reached!: () => void, release!: () => void;
    const cloning = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.git.beforeClone = async () => {
      reached();
      await proceed;
    };
    const first = prepare();
    await cloning;
    const second = prepare('github-11', 'https://github.com/another/repo.git');
    const conflict = assert.rejects(second, /repository-identity-conflict/u);
    release();
    await Promise.all([first, conflict]);
    assert.equal(fixture.git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
  });

  it('should keep a configured clone failure actionable without a bare fallback', async () => {
    fixture.git.failClone = true;
    await assert.rejects(prepare(), /Git clone failed/u);
    assert.equal(fixture.git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
    assert.deepEqual(await readdir(fixture.layout.workingDirectory!), []);
    assert.equal(
      fixture.git.calls.some(({ argv }) => argv.includes('--bare')),
      false,
    );
  });

  it('should reject unsafe destinations and symlinked ancestors without repairs', async () => {
    const working = fixture.layout.workingDirectory!;
    await mkdir(working);
    await chmod(working, 0o777);
    await assert.rejects(prepare(), /repository-path-unsafe/u);
    await chmod(working, 0o700);
    const outside = join(fixture.workspaceDir, 'outside');
    await fixture.git.seed(outside);
    await symlink(outside, join(working, 'repo'));
    await assert.rejects(prepare(), /repository-path-unsafe/u);
    assert.equal(fixture.git.calls.length, 0);
  });

  it('should retain a partial clone after interruption and resume a verified temporary clone without recloning', async () => {
    const path = join(fixture.layout.workingDirectory!, 'repo');
    const temporaryPath = path + '.12345678-1234-1234-1234-123456789012.tmp';
    const record = join(
      fixture.layout.repositoryRoot,
      gitWorktreeRepositoryDirectoryName(id) + '.repository.json',
    );
    await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
    await writeFile(
      record,
      JSON.stringify({ version: 1, repositoryId: id, source, path, temporaryPath }),
      { mode: 0o600 },
    );
    await assert.rejects(prepare(), /repository-clone-interrupted/u);
    await fixture.git.seed(temporaryPath);
    assert.equal((await prepare()).path, path);
    assert.equal(
      fixture.git.calls.some(({ argv }) => argv[0] === 'clone'),
      false,
    );
    assert.equal(JSON.parse(await readFile(record, 'utf8')).temporaryPath, undefined);
  });

  it('should retain the managed bare fallback and verify its remote before reuse', async () => {
    delete fixture.layout.workingDirectory;
    const first = await prepare();
    assert.equal(
      first.path,
      join(fixture.layout.repositoryRoot, gitWorktreeRepositoryDirectoryName(id)),
    );
    assert.equal(
      fixture.git.calls.find(({ argv }) => argv[0] === 'clone')!.argv.includes('--bare'),
      true,
    );
    await fixture.git.seed(first.path, 'https://elsewhere.example/owner/repo.git', true);
    await assert.rejects(prepare(), /repository-identity-conflict/u);
  });

  it('should block a changed destination after retained preparation', async () => {
    const first = await prepare();
    fixture.layout.workingDirectory = join(fixture.workspaceDir, 'changed');
    await assert.rejects(
      prepare(),
      (error: unknown) => error instanceof RepositoryPreparationError && error.path === first.path,
    );
    assert.equal(fixture.git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
  });
});
