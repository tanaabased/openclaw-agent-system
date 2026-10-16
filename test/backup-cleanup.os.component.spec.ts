import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import BackupAttemptWriter from '../agent/backup-attempt.ts';
import cleanup, { BackupCleanupError, backupOwnerState } from '../agent/backup-cleanup.ts';
import WorkspaceBackupService from '../agent/backup-service.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

describe('agent/backup-cleanup', () => {
  let root: string;
  let workspaceDir: string;
  let control: string;
  let output: string;
  let stage: string;
  let attempt: BackupAttemptWriter;
  const scope = () => ({ agentId: 'cleanup-bot', workspaceDir, output });
  const run = (apply = false, more: Partial<Parameters<typeof cleanup>[0]> = {}) =>
    cleanup({
      ...scope(),
      apply,
      ownerState: () => 'absent',
      ...more,
    });
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'backup-cleanup-')));
    workspaceDir = join(root, 'workspace');
    control = join(workspaceDir, '.agent-system/backup-staging');
    output = join(workspaceDir, '.agent-system/backups');
    await mkdir(control, { recursive: true, mode: 0o700 });
    await mkdir(output, { mode: 0o700 });
    stage = await mkdtemp(join(control, 'capture-'));
    attempt = new BackupAttemptWriter(control, scope());
    await attempt.add(stage);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function artifact(path: string, bytes: string | Buffer, archive = false) {
    await writeFile(path, '', { flag: 'wx', mode: 0o600 });
    await attempt.add(path, archive);
    await writeFile(path, bytes);
  }

  it('should leave preview bytes modes mtimes and directory entries unchanged', async () => {
    const path = join(stage, 'archive.tar.gz');
    await artifact(path, gzipSync('incomplete').subarray(0, 12), true);
    const before = await Promise.all([
      lstat(control),
      lstat(stage),
      lstat(path),
      lstat(attempt.path),
    ]);
    const names = await readdir(control);
    const record = await readFile(attempt.path);
    const result = await run();
    assert.deepEqual(new Set(result.wouldDelete), new Set([path, stage]));
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(await readdir(control), names);
    assert.deepEqual(await readFile(attempt.path), record);
    const after = await Promise.all([
      lstat(control),
      lstat(stage),
      lstat(path),
      lstat(attempt.path),
    ]);
    assert.deepEqual(
      after.map(({ mode, mtimeMs }) => [mode, mtimeMs]),
      before.map(({ mode, mtimeMs }) => [mode, mtimeMs]),
    );
  });

  it('should remove owned incomplete artifacts and leave repeated apply unchanged', async () => {
    const path = join(stage, 'archive.tar.gz');
    await artifact(path, Buffer.from([0x1f]), true);
    const pending = join(output, `.pending-${randomUUID()}.tar.gz`);
    await artifact(pending, '', true);
    const first = await run(true);
    assert.deepEqual(new Set(first.deleted), new Set([stage, path, pending]));
    assert.deepEqual(first.wouldDelete, []);
    assert.deepEqual((await run(true)).deleted, []);
    assert.ok(await readFile(attempt.path));
  });

  it('should preserve complete plausible unsupported and nested archives without extraction', async () => {
    for (const [name, content] of [
      ['complete.tar.gz', gzipSync('complete gzip')],
      ['missing-trailer.tar.gz', gzipSync(Buffer.alloc(2048)).subarray(0, -8)],
      ['unknown.tar.gz', Buffer.from('unsupported archive')],
      ['nested.zip', Buffer.from('unsupported format')],
    ] as const) {
      const path = join(stage, name);
      await artifact(path, content);
      const result = await run(true);
      assert.deepEqual(result.deleted, []);
      assert.ok(result.preserved.some(({ reason }) => reason === 'complete-or-uncertain-archive'));
      assert.deepEqual(await readFile(path), content);
      await unlink(path);
    }
  });

  it('should preserve a staged complete archive while removing a separate incomplete pending copy', async () => {
    await artifact(join(stage, 'archive.tar.gz'), gzipSync('complete'), true);
    const pending = join(output, `.pending-${randomUUID()}.tar.gz`);
    await artifact(pending, '', true);
    const result = await run(true);
    assert.deepEqual(result.deleted, [pending]);
    assert.ok(await lstat(stage));
  });

  it('should refuse live reused unknown and possibly orphaned snapshot writers', async () => {
    assert.equal(backupOwnerState(process.pid), 'live');
    for (const owner of ['live', 'unknown'] as const) {
      const result = await run(true, { ownerState: () => owner });
      assert.deepEqual(result.deleted, []);
      assert.ok(result.preserved.some(({ reason }) => reason.includes('owner-')));
    }
    attempt.record.snapshotWriter = true;
    await attempt.save();
    const result = await run(true);
    assert.deepEqual(result.deleted, []);
    assert.ok(result.preserved.some(({ reason }) => reason === 'snapshot-writer-uncertain'));
  });

  it('should preserve legacy unowned and unexpected contents including published archives', async () => {
    await writeFile(join(stage, 'unrecorded'), 'unknown');
    const legacy = join(output, `.pending-${randomUUID()}.tar.gz`);
    await writeFile(legacy, '');
    await writeFile(join(output, 'published.tar.gz'), 'complete');
    const result = await run(true);
    assert.deepEqual(result.deleted, []);
    assert.ok(result.preserved.some(({ reason }) => reason === 'unknown-contents'));
    assert.ok(
      result.preserved.some(({ path, reason }) => path === legacy && reason === 'unattributed'),
    );
    assert.equal(await readFile(join(output, 'published.tar.gz'), 'utf8'), 'complete');
  });

  it('should reject another agent workspace output and escaping artifact ownership', async () => {
    for (const change of [
      { agentId: 'other-bot' },
      { workspaceDir: join(root, 'other') },
      { output: join(root, 'other-output') },
    ]) {
      const saved = { ...attempt.record };
      Object.assign(attempt.record, change);
      await writeFile(attempt.path, JSON.stringify(attempt.record));
      const result = await run(true);
      assert.deepEqual(result.deleted, []);
      assert.ok(result.preserved.some(({ reason }) => reason === 'ownership-mismatch'));
      Object.assign(attempt.record, saved);
    }
    attempt.record.artifacts.push({ ...attempt.record.artifacts[0]!, path: join(root, 'outside') });
    await writeFile(attempt.path, JSON.stringify(attempt.record));
    assert.deepEqual((await run(true)).deleted, []);
    assert.ok((await run()).preserved.some(({ reason }) => reason === 'artifact-outside-scope'));
  });

  it('should preserve replaced inodes symbolic links and malformed private records', async () => {
    const old = `${stage}-old`;
    await rename(stage, old);
    await mkdir(stage, { mode: 0o700 });
    assert.ok((await run(true)).preserved.some(({ reason }) => reason === 'artifact-changed'));
    await rm(stage, { recursive: true });
    await symlink(old, stage);
    assert.deepEqual((await run(true)).deleted, []);
    await writeFile(attempt.path, '{unfinished');
    await assert.rejects(run(true), BackupCleanupError);
  });

  it('should share capture exclusion and stop on changed paths with exact partial progress', async () => {
    const lock = await acquirePrivateStateFileLock(join(control, 'capture'), {
      staleMs: 30000,
      retries: { retries: 0, minTimeout: 1, maxTimeout: 1, factor: 1 },
    });
    try {
      await assert.rejects(
        run(true),
        (error: unknown) =>
          error instanceof BackupCleanupError && error.code === 'private-state-file-lock-busy',
      );
    } finally {
      await lock.release();
    }
    const first = join(stage, 'a');
    const second = join(stage, 'b');
    await artifact(first, 'a');
    await artifact(second, 'b');
    await assert.rejects(
      run(true, {
        beforeDelete: async (path) => {
          if (path === second) await writeFile(path, 'changed');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof BackupCleanupError);
        assert.deepEqual(error.result.deleted, [first]);
        assert.deepEqual(new Set(error.result.wouldDelete), new Set([second, stage]));
        return error.code === 'backup-cleanup-race';
      },
    );
  });

  it('should recheck owner and record identity before each deletion', async () => {
    let owner: 'absent' | 'live' = 'absent';
    await assert.rejects(
      run(true, {
        ownerState: () => owner,
        beforeDelete: async () => {
          owner = 'live';
        },
      }),
      (error: unknown) =>
        error instanceof BackupCleanupError &&
        error.code === 'backup-cleanup-race' &&
        error.result.deleted.length === 0,
    );
    await assert.rejects(
      run(true, {
        beforeDelete: async () => {
          await writeFile(attempt.path, JSON.stringify(attempt.record));
        },
      }),
      (error: unknown) =>
        error instanceof BackupCleanupError &&
        error.code === 'backup-cleanup-race' &&
        error.result.deleted.length === 0,
    );
    assert.ok(await lstat(stage));
  });

  it('should stop before deleting when the enclosing lease is lost', async () => {
    let lost = false;
    const guard = {
      signal: new AbortController().signal,
      assertHeld() {
        if (lost) throw new Error('lost');
      },
    };
    await assert.rejects(
      withPrivateStateLock(guard, () =>
        run(true, {
          beforeDelete: async () => {
            lost = true;
          },
        }),
      ),
      /lost/u,
    );
    assert.ok(await lstat(stage));
  });

  it('should reject unsafe roots and work without source selection or creating missing state', async () => {
    await chmod(control, 0o755);
    await assert.rejects(run(), /unsafe/u);
    await chmod(control, 0o700);
    const service = new WorkspaceBackupService();
    const manifest = {
      schemaVersion: 1 as const,
      agent: { id: 'cleanup-bot' },
      backup: { include: ['missing-file'], openclawState: 'off' as const },
    };
    await service.cleanup({ manifest, workspaceDir, apply: false });
    await assert.rejects(
      service.cleanup({
        manifest,
        workspaceDir,
        apply: true,
        expectedOutput: join(root, 'changed-output'),
      }),
      /destination changed/u,
    );
    await rm(control, { recursive: true });
    await rm(output, { recursive: true });
    const before = await readdir(join(workspaceDir, '.agent-system'));
    assert.deepEqual(
      (await service.cleanup({ manifest, workspaceDir, apply: false })).wouldDelete,
      [],
    );
    assert.deepEqual(await readdir(join(workspaceDir, '.agent-system')), before);
    await symlink(root, control);
    await assert.rejects(run(), /unsafe/u);
  });

  it('should leave no records after normal creation and retain snapshot uncertainty on failure', async () => {
    await rm(control, { recursive: true });
    await writeFile(join(workspaceDir, 'memory.md'), 'hello');
    const manifest = {
      schemaVersion: 1 as const,
      agent: { id: 'cleanup-bot' },
      backup: { openclawState: 'off' as const },
    };
    const service = new WorkspaceBackupService();
    const created = await service.create(await service.plan({ manifest, workspaceDir }));
    assert.equal((await service.verify(created.archive)).agentId, 'cleanup-bot');
    assert.deepEqual(await readdir(control), []);
    const agentDir = join(root, 'agent');
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'openclaw-agent.sqlite'), 'fixture');
    const failing = new WorkspaceBackupService(
      async () => ({ paths: [], agentDir }),
      async () => {
        throw new Error('uncertain child');
      },
    );
    await assert.rejects(
      failing.create(
        await failing.plan({
          manifest: { ...manifest, backup: { openclawState: 'required' } },
          workspaceDir,
        }),
      ),
    );
    const preserved = await run(true);
    assert.ok(preserved.preserved.some(({ reason }) => reason === 'snapshot-writer-uncertain'));
    assert.deepEqual(preserved.deleted, []);
    // published bytes are never a cleanup target, even when copied into a legacy pending path.
    await copyFile(created.archive, join(output, `.pending-${randomUUID()}.tar.gz`));
    assert.deepEqual((await run(true)).deleted, []);
  });
});
