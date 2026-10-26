import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  unlink,
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
import type { OpenClawSnapshotManifest, WorkspaceBackupManifest } from '../agent/backup-types.ts';
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

  it('should prune existing archives when current backup inputs are missing', async () => {
    const older = await fixture('older.tar.gz', '2026-09-01T00:00:00.000Z');
    const newer = await fixture('newer.tar.gz', '2026-09-02T00:00:00.000Z');
    const manifest = {
      ...agent,
      backup: { ...agent.backup, include: ['removed-file.txt'] },
    };
    const options = { manifest, workspaceDir: workspace, keep: 1 };
    assert.deepEqual((await service.prune({ ...options, dryRun: true })).wouldDelete, [older]);
    const applied = await service.prune({ ...options, dryRun: false });
    assert.deepEqual(applied.deleted, [older]);
    assert.deepEqual(applied.kept, [newer]);
  });

  it('should retain and expire mixed database schemas without invoking compatibility checks', async () => {
    const paths: string[] = [];
    for (const [day, userVersion] of [
      [1, 24],
      [2, 24],
      [3, 25],
    ] as const) {
      const capturedAt = `2026-09-0${day}T00:00:00.000Z`;
      const snapshot = join(root, `snapshot-${day}`);
      await mkdir(snapshot);
      // synthetic database bytes; schema compatibility belongs to the injected command.
      const bytes = Buffer.from(`database schema ${userVersion}`);
      const manifest: OpenClawSnapshotManifest = {
        schemaVersion: 1,
        snapshotId: `snapshot-${day}`,
        createdAt: capturedAt,
        database: {
          role: 'agent',
          agentId: 'tanaabot',
          basename: 'openclaw-agent.sqlite',
          userVersion,
        },
        artifact: {
          path: 'database.sqlite',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.length,
        },
      };
      await writeFile(join(snapshot, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(join(snapshot, 'database.sqlite'), bytes);
      const archive = join(output, `schema-${day}.tar.gz`);
      await writeWorkspaceArchive(
        archive,
        workspace,
        {
          format: 'agent-system-backup',
          version: 2,
          agentId: 'tanaabot',
          capturedAt,
          inventory: [],
          diagnostics: [],
          settings: {
            output,
            gitIgnore: false,
            openclawState: 'required',
            include: [],
            exclude: [],
          },
          coverage: {
            stage: 'workspace-and-agent-state',
            openclawState: 'captured',
            atomic: false,
            omittedPaths: [],
            limitations: [],
          },
          snapshot: { manifest, openclawVersion: 'fixture', agentSystemVersion: 'fixture' },
        },
        undefined,
        snapshot,
      );
      paths.push(archive);
    }
    const calls: string[][] = [];
    const selected = new WorkspaceBackupService(undefined, async (args) => {
      calls.push(args);
      assert.deepEqual(args.slice(0, 3), ['backup', 'sqlite', 'verify']);
      const directory = args[3]!;
      const manifest = JSON.parse(
        await readFile(join(directory, 'manifest.json'), 'utf8'),
      ) as OpenClawSnapshotManifest;
      return manifest.database.userVersion === 25
        ? {
            code: 0,
            stdout: JSON.stringify({ ok: true, snapshotPath: directory, manifest }),
            stderr: '',
          }
        : { code: 1, stdout: '', stderr: 'schema 24 is incompatible with required schema 25' };
    });
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const preview = await prune(2, true, selected);
    assert.deepEqual(preview.kept, [paths[2], paths[1]]);
    assert.deepEqual(preview.wouldDelete, [paths[0]]);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
    const applied = await prune(2, false, selected);
    assert.deepEqual(applied.kept, preview.kept);
    assert.deepEqual(applied.deleted, preview.wouldDelete);
    assert.deepEqual(calls, []);
    assert.deepEqual(
      await Promise.all(paths.slice(1).map((path) => readFile(path))),
      before.slice(1),
    );
    await assert.rejects(selected.verify(paths[1]!), { code: 'backup-snapshot-failed' });
    await selected.verify(paths[2]!);
    assert.equal(calls.length, 2);
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

  it('should reject an invalid count without modifying archives', async () => {
    const path = await fixture('archive.tar.gz', '2026-09-01T00:00:00.000Z');
    const bytes = await readFile(path);
    await assert.rejects(prune(0), { code: 'backup-keep-invalid' });
    assert.deepEqual(await readFile(path), bytes);
  });

  it('should keep metadata selection separate from explicit payload integrity verification', async () => {
    const older = await fixture('older.tar.gz', '2026-09-01T00:00:00.000Z');
    const newest = await fixture('newest.tar.gz', '2026-09-02T00:00:00.000Z');
    const bytes = await readFile(newest);
    await writeFile(newest, bytes.subarray(0, -8));
    await assert.rejects(service.verify(newest), { code: 'backup-archive-invalid' });
    const preview = await prune(1, true);
    assert.deepEqual(preview.kept, [newest]);
    assert.deepEqual(preview.wouldDelete, [older]);
    assert.deepEqual((await prune(1)).deleted, preview.wouldDelete);
    assert.deepEqual(await readFile(newest), bytes.subarray(0, -8));
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

  it('should stop if a retained archive changes at the deletion boundary', async () => {
    const older = await fixture('older.tar.gz', '2026-09-01T00:00:00.000Z');
    const newer = await fixture('newer.tar.gz', '2026-09-02T00:00:00.000Z');
    const selected = new WorkspaceBackupService(undefined, undefined, async () => {
      await writeFile(newer, 'concurrent replacement');
    });
    await assert.rejects(prune(1, false, selected), { code: 'backup-prune-race' });
    assert.equal((await lstat(older)).isFile(), true);
    assert.equal(await readFile(newer, 'utf8'), 'concurrent replacement');
  });

  it('should stop if a candidate disappears before deletion', async () => {
    const oldest = await fixture('oldest.tar.gz', '2026-09-01T00:00:00.000Z');
    const middle = await fixture('middle.tar.gz', '2026-09-02T00:00:00.000Z');
    await fixture('newest.tar.gz', '2026-09-03T00:00:00.000Z');
    const selected = new WorkspaceBackupService(undefined, undefined, async () => {
      await unlink(middle);
    });
    await assert.rejects(prune(1, false, selected), (error: unknown) => {
      assert.ok(error instanceof BackupPruneError);
      assert.equal(error.code, 'backup-prune-race');
      assert.deepEqual(error.result.deleted, []);
      return true;
    });
    assert.equal((await lstat(oldest)).isFile(), true);
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

  it('should preserve ambiguous root metadata without counting it in preview or apply', async () => {
    const older = await fixture('older.tar.gz', '2026-09-01T00:00:00.000Z');
    const newer = await fixture('newer.tar.gz', '2026-09-02T00:00:00.000Z');
    const base = await service.verify(newer);
    assert.equal(base.version, 2);
    const roots = [
      'not json',
      JSON.stringify({ ...base, format: 'another-format' }),
      JSON.stringify({ ...base, version: 3 }),
      JSON.stringify({ ...base, agentId: '../tanaabot' }),
      JSON.stringify({ ...base, capturedAt: '2026-09-03T00:00:00Z' }),
      JSON.stringify({ ...base, capturedAt: '2026-02-30T00:00:00.000Z' }),
      JSON.stringify({ ...base, coverage: { ...base.coverage, openclawState: 'captured' } }),
      JSON.stringify({
        ...base,
        inventory: [{ path: '../escape', type: 'directory', mode: 448, size: 0 }],
      }),
    ];
    const paths = [];
    for (const [index, content] of roots.entries()) {
      const path = join(output, `ambiguous-${index}.tar.gz`);
      const stream = pack();
      const writing = pipeline(stream, createGzip(), createWriteStream(path));
      stream.entry({ name: 'manifest.json', type: 'file' }, content);
      stream.finalize();
      await writing;
      paths.push(path);
    }
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const preview = await prune(1, true);
    assert.deepEqual(preview.kept, [newer]);
    assert.deepEqual(preview.wouldDelete, [older]);
    assert.deepEqual(new Set(preview.skipped.map(({ path }) => path)), new Set(paths));
    assert.ok(preview.skipped.every(({ reason }) => reason.startsWith('backup-')));
    const applied = await prune(1);
    assert.deepEqual(applied.kept, preview.kept);
    assert.deepEqual(applied.deleted, preview.wouldDelete);
    assert.deepEqual(applied.skipped, preview.skipped);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
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
