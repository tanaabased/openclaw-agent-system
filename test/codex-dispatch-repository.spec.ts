import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import prepareDispatchRepository, {
  type DispatchRepositoryPreparation,
} from '../agent/codex-dispatch-repository.ts';
import { repositoryFixture } from './git-repository-fixture.ts';

const source = 'https://github.com/owner/repo.git';

describe('agent/codex-dispatch-repository', () => {
  let fixture: Awaited<ReturnType<typeof repositoryFixture>>;
  let retained: DispatchRepositoryPreparation | undefined;
  beforeEach(async () => {
    fixture = await repositoryFixture();
    retained = undefined;
  });
  afterEach(async () => {
    await rm(fixture.workspaceDir, { recursive: true, force: true });
  });
  const prepare = (bare = false, authorize = async () => {}) =>
    prepareDispatchRepository(
      {
        workspace: fixture.workspaceDir,
        configuration: bare ? {} : fixture.configuration,
        repositoryId: 'github-10',
        repository: 'owner/repo',
        cloneUrl: source,
        defaultBranch: 'main',
        previous: retained,
      },
      {
        git: fixture.git.execute.bind(fixture.git),
        authorize,
        retain: async (value) => {
          retained = structuredClone(value);
        },
      },
    );

  it('should retain a normal checkout for manual project registration and reuse it on retry', async () => {
    const path = await prepare();
    assert.equal(retained?.path, path);
    assert.equal(retained?.checkout, path);
    assert.equal(retained?.identity, 'github.com/owner/repo');
    assert.equal(await prepare(), path);
    assert.equal(fixture.git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
    assert.equal(
      fixture.git.calls.some(({ argv }) => argv[0] === 'worktree'),
      false,
    );
  });

  it('should materialize one stable bare-backed base checkout without an issue branch', async () => {
    const checkout = await prepare(true);
    assert.notEqual(retained?.path, checkout);
    assert.equal(retained?.checkout, checkout);
    await writeFile(join(checkout, 'user-work'), 'preserve');
    assert.equal(await prepare(true), checkout);
    assert.equal(await readFile(join(checkout, 'user-work'), 'utf8'), 'preserve');
    assert.equal(fixture.git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
    const adds = fixture.git.calls.filter(
      ({ argv }) => argv[0] === 'worktree' && argv[1] === 'add',
    );
    assert.equal(adds.length, 1);
    assert.deepEqual(adds[0]!.argv, ['worktree', 'add', '--detach', checkout, fixture.git.commit]);
  });

  it('should stop before preparation on revoked activation and preserve the retained record', async () => {
    await assert.rejects(
      prepare(false, async () => {
        throw new Error('dispatch-policy-changed');
      }),
      /dispatch-policy-changed/u,
    );
    assert.equal(retained, undefined);
    assert.equal(fixture.git.calls.length, 0);
  });

  it('should retain a missing registered base checkout without creating a duplicate', async () => {
    const checkout = await prepare(true);
    await rm(checkout, { recursive: true });
    await assert.rejects(prepare(true), /repository-workspace-interrupted/u);
    assert.equal(retained?.checkout, checkout);
    assert.equal(
      fixture.git.calls.filter(({ argv }) => argv[0] === 'worktree' && argv[1] === 'add').length,
      1,
    );
  });

  it('should report native clone access failure with the selected path and no bare fallback', async () => {
    fixture.git.failClone = true;
    await assert.rejects(prepare(), {
      code: 'repository-git-unavailable',
      path: join(fixture.workspaceDir, 'checkouts', 'repo'),
      identity: 'github.com/owner/repo',
    });
    assert.equal(retained?.checkout, undefined);
    assert.equal(fixture.git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
    assert.ok(!fixture.git.calls.some(({ argv }) => argv.includes('--bare')));
  });

  it('should reject a changed path after setup without a second clone', async () => {
    const checkout = await prepare();
    fixture.configuration.repositories.workingDirectory = 'different';
    await assert.rejects(prepare(), /repository-preparation-changed/u);
    assert.equal(retained?.checkout, checkout);
    assert.equal(fixture.git.calls.filter(({ argv }) => argv[0] === 'clone').length, 1);
  });
});
