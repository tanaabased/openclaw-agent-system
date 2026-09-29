import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack } from 'tar-stream';

import WorkspaceBackupService, { BackupPruneError } from '../agent/backup-service.ts';
import { writeWorkspaceArchive } from '../agent/backup-archive.ts';
import type { WorkspaceBackupManifest } from '../agent/backup-types.ts';
import type { AgentManifest } from '../manifest/types.ts';
import backupPrune from '../cli/backup-prune.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

describe('workspace backup pruning', () => {
  let root: string;
  let workspace: string;
  let output: string;
  const agent: AgentManifest = {
    schemaVersion: 1,
    agent: { id: 'tanaabot' },
    backup: { openclawState: 'off' },
  };
  const service = new WorkspaceBackupService();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'backup-prune-'));
    root = await realpath(root);
    workspace = join(root, 'workspace');
    output = join(workspace, '.agent-system', 'backups');
    await mkdir(output, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(
    name: string,
    capturedAt: string,
    agentId = 'tanaabot',
    version: 1 | 2 = 2,
  ) {
    const path = join(output, name);
    const common = {
      format: 'agent-system-backup' as const,
      agentId,
      capturedAt,
      inventory: [],
      diagnostics: [],
    };
    const manifest: WorkspaceBackupManifest =
      version === 1
        ? {
            ...common,
            version: 1,
            settings: { output, gitIgnore: false, include: [], exclude: [] },
            coverage: {
              stage: 'workspace-only',
              openclawState: 'unsupported',
              atomic: false,
              omittedPaths: [],
              limitations: [],
            },
          }
        : {
            ...common,
            version: 2,
            settings: { output, gitIgnore: false, openclawState: 'off', include: [], exclude: [] },
            coverage: {
              stage: 'workspace-only',
              openclawState: 'off',
              atomic: false,
              omittedPaths: [],
              limitations: [],
            },
          };
    await writeWorkspaceArchive(path, workspace, manifest);
    return path;
  }
  const prune = (keep: number, dryRun = false, selected = service) =>
    selected.prune({
      manifest: agent,
      workspaceDir: workspace,
      keep,
      dryRun,
    });

  it('should retain newest embedded dates across versions, names and filesystem dates', async () => {
    const dates = [1, 2, 3, 4, 5].map(
      (day) => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    );
    const paths = await Promise.all(
      dates.map((date, index) =>
        fixture(`renamed-${5 - index}.tar.gz`, date, 'tanaabot', index % 2 ? 1 : 2),
      ),
    );
    await utimes(paths[0]!, new Date('2030-01-01'), new Date('2030-01-01'));
    await utimes(paths[4]!, new Date('2020-01-01'), new Date('2020-01-01'));
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const preview = await prune(3, true);
    assert.deepEqual(preview.kept, paths.slice(2).reverse());
    assert.deepEqual(preview.wouldDelete, paths.slice(0, 2).reverse());
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
    const applied = await prune(3);
    assert.deepEqual(applied.deleted, preview.wouldDelete);
    assert.deepEqual(applied.wouldDelete, []);
    assert.deepEqual((await prune(3)).deleted, []);
    assert.deepEqual((await readdir(output)).length, 3);
  });

  it('should leave mixed agents and nonarchives untouched without counting them', async () => {
    const first = await fixture('a.tar.gz', '2026-09-01T00:00:00.000Z');
    const second = await fixture('b.tar.gz', '2026-09-02T00:00:00.000Z');
    const foreign = await fixture('foreign.tar.gz', '2026-09-09T00:00:00.000Z', 'other');
    await writeFile(join(output, 'note'), 'unrelated');
    await writeFile(join(output, '.pending-write.tar.gz'), 'pending');
    await writeFile(join(output, 'bad.tar.gz'), 'corrupt');
    await mkdir(join(output, 'nested'));
    await symlink(first, join(output, 'link.tar.gz'));
    const preserved = await Promise.all(
      [foreign, join(output, 'note'), join(output, 'bad.tar.gz')].map((path) => readFile(path)),
    );
    const result = await prune(1);
    assert.deepEqual(result.kept, [second]);
    assert.deepEqual(result.deleted, [first]);
    assert.equal(result.skipped.length, 6);
    assert.deepEqual(
      await Promise.all(
        [foreign, join(output, 'note'), join(output, 'bad.tar.gz')].map((path) => readFile(path)),
      ),
      preserved,
    );
    assert.equal((await lstat(join(output, 'link.tar.gz'))).isSymbolicLink(), true);
  });

  it('should reject an invalid count and abort before deletion when retained verification fails', async () => {
    const older = await fixture('older.tar.gz', '2026-09-01T00:00:00.000Z');
    const newest = await fixture('newest.tar.gz', '2026-09-02T00:00:00.000Z');
    await assert.rejects(prune(0), { code: 'backup-keep-invalid' });
    const bytes = await readFile(newest);
    await writeFile(newest, bytes.subarray(0, -8));
    // a valid metadata entry with a broken payload must never trigger deletion of an older copy.
    await assert.rejects(prune(1), { code: 'backup-retained-verification-failed' });
    assert.equal((await lstat(older)).isFile(), true);
  });

  it('should detect replacement at the injected deletion boundary', async () => {
    const older = await fixture('older.tar.gz', '2026-09-01T00:00:00.000Z');
    await fixture('newer.tar.gz', '2026-09-02T00:00:00.000Z');
    const replacement = join(output, 'newer.tar.gz');
    const selected = new WorkspaceBackupService(undefined, undefined, async (path) => {
      if (path === older) await copyFile(replacement, older);
    });
    await assert.rejects(prune(1, false, selected), (error: unknown) => {
      assert.ok(error instanceof BackupPruneError);
      assert.equal(error.code, 'backup-prune-race');
      assert.deepEqual(error.result.deleted, []);
      return true;
    });
    assert.equal((await lstat(older)).isFile(), true);
  });

  it('should stop if a new backup appears at the deletion boundary', async () => {
    const older = await fixture('older.tar.gz', '2026-09-01T00:00:00.000Z');
    await fixture('newer.tar.gz', '2026-09-02T00:00:00.000Z');
    const selected = new WorkspaceBackupService(undefined, undefined, async () => {
      await fixture('concurrent.tar.gz', '2026-09-03T00:00:00.000Z');
    });
    await assert.rejects(prune(1, false, selected), { code: 'backup-prune-race' });
    assert.equal((await lstat(older)).isFile(), true);
  });

  it('should make zero, fewer than keep, and exactly keep eligible archives no-ops', async () => {
    assert.deepEqual((await prune(3)).deleted, []);
    await fixture('a.tar.gz', '2026-09-01T00:00:00.000Z');
    assert.deepEqual((await prune(3)).deleted, []);
    await fixture('b.tar.gz', '2026-09-02T00:00:00.000Z');
    assert.deepEqual((await prune(2)).deleted, []);
  });

  it('should break equal capture timestamps by filename', async () => {
    const date = '2026-09-01T00:00:00.000Z';
    const a = await fixture('a.tar.gz', date);
    const b = await fixture('b.tar.gz', date);
    assert.deepEqual((await prune(1, true)).kept, [a]);
    assert.deepEqual((await prune(1)).deleted, [b]);
  });

  it('should skip invalid timestamp metadata without counting or deleting it', async () => {
    const invalid = join(output, 'invalid.tar.gz');
    const stream = pack();
    const writing = pipeline(stream, createGzip(), createWriteStream(invalid));
    stream.entry(
      { name: 'manifest.json', type: 'file' },
      JSON.stringify({
        format: 'agent-system-backup',
        version: 2,
        agentId: 'tanaabot',
        capturedAt: 'not-a-date',
      }),
    );
    stream.finalize();
    await writing;
    const valid = await fixture('valid.tar.gz', '2026-09-01T00:00:00.000Z');
    const result = await prune(1);
    assert.deepEqual(result.kept, [valid]);
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.skipped, [{ path: invalid, reason: 'backup-manifest-invalid' }]);
    assert.equal((await lstat(invalid)).isFile(), true);
  });

  it('should report completed deletions if a later candidate fails', async () => {
    const oldest = await fixture('oldest.tar.gz', '2026-09-01T00:00:00.000Z');
    const middle = await fixture('middle.tar.gz', '2026-09-02T00:00:00.000Z');
    await fixture('newest.tar.gz', '2026-09-03T00:00:00.000Z');
    const selected = new WorkspaceBackupService(undefined, undefined, async (path) => {
      if (path === oldest) throw new Error('injected deletion error');
    });
    await assert.rejects(prune(1, false, selected), (error: unknown) => {
      assert.ok(error instanceof BackupPruneError);
      assert.deepEqual(error.result.deleted, [middle]);
      assert.deepEqual(error.result.wouldDelete, [oldest]);
      return true;
    });
    assert.equal((await lstat(oldest)).isFile(), true);
  });

  it('should reject invalid cli counts and read-only setup apply before mutation', async () => {
    const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
      status: 'loaded',
      manifest: agent,
      scope: { workspaceDir: workspace },
      path: join(workspace, 'agent.yaml'),
      digest: 'fixture',
      diagnostics: [],
      validationChecks: [],
    };
    const lines: string[] = [];
    let exitCode = 0;
    const options = {
      service,
      manifestService: {
        async loadForAgentId() {
          return loaded;
        },
        async loadForCommandDirectory() {
          return loaded;
        },
      },
      workspaceDir: workspace,
      environment: {},
      json: true,
      output: {
        writeStdout(value: string) {
          lines.push(value);
        },
        writeStderr() {},
      },
      setExitCode(code: number) {
        exitCode = code;
      },
      commandAuthority: {
        async resolve() {
          return {
            agentId: 'tanaabot',
            workingDirectory: workspace,
            admittedWorkingDirectories: [workspace],
            setupMode: 'check' as const,
          };
        },
      },
    };
    for (const keep of [undefined, '0', '-1', '1.5', '1e2', 'NaN']) {
      await backupPrune({ ...options, keep, dryRun: false });
      assert.equal(JSON.parse(lines.pop()!).diagnostics[0].code, 'backup-keep-invalid');
      assert.equal(exitCode, 1);
    }
    await backupPrune({ ...options, keep: '1', dryRun: false });
    assert.equal(JSON.parse(lines.pop()!).diagnostics[0].code, 'backup-setup-check-read-only');
    await backupPrune({ ...options, keep: '1', dryRun: true });
    assert.equal(JSON.parse(lines.pop()!).status, 'preview');
    await backupPrune({ ...options, keep: '1', dryRun: true, destination: join(root, 'outside') });
    assert.equal(JSON.parse(lines.pop()!).diagnostics[0].code, 'backup-output-outside-scope');
  });
});
