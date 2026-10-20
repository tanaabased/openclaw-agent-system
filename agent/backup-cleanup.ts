import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { createGunzip } from 'node:zlib';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import {
  assertPrivateStateLocksHeld,
  withPrivateStateLock,
} from '../core/private-state-lock-context.ts';
import isPathContained from '../utils/is-path-contained.ts';
import nodeErrorCode from '../utils/node-error-code.ts';
import {
  backupArtifactIdentity,
  type BackupAttempt,
  type BackupArtifactIdentity,
} from './backup-attempt.ts';
import { BackupError, backupControlDirectory } from './backup-types.ts';

const identitySchema = Type.Object(
  {
    dev: Type.Number(),
    ino: Type.Number(),
    mode: Type.Number(),
    uid: Type.Number(),
    birthtimeMs: Type.Number(),
  },
  { additionalProperties: false },
);
const attemptSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: Type.String({ pattern: '^[a-f0-9-]{36}$' }),
    agentId: Type.String(),
    workspaceDir: Type.String(),
    output: Type.String(),
    pid: Type.Integer({ minimum: 1 }),
    snapshotWriter: Type.Boolean(),
    artifacts: Type.Array(
      Type.Object(
        {
          path: Type.String(),
          identity: identitySchema,
          archive: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100000 },
    ),
  },
  { additionalProperties: false },
);

const artifactEventSchema = Type.Object(
  { artifact: attemptSchema.properties.artifacts.items },
  { additionalProperties: false },
);
const writerEventSchema = Type.Object(
  { snapshotWriter: Type.Boolean() },
  { additionalProperties: false },
);

export interface BackupCleanupResult {
  agentId: string;
  workspaceDir: string;
  output: string;
  wouldDelete: string[];
  deleted: string[];
  preserved: { path: string; reason: string }[];
}

export class BackupCleanupError extends BackupError {
  constructor(
    code: string,
    message: string,
    readonly result: BackupCleanupResult,
  ) {
    super(code, message);
  }
}

function sameIdentity(
  stats: Awaited<ReturnType<typeof lstat>>,
  expected: BackupAttempt['artifacts'][number]['identity'],
) {
  return (
    stats.dev === expected.dev &&
    stats.ino === expected.ino &&
    stats.mode === expected.mode &&
    stats.uid === expected.uid &&
    stats.birthtimeMs === expected.birthtimeMs
  );
}

function fingerprint(stats: Awaited<ReturnType<typeof lstat>>): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.uid,
    stats.nlink,
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
  ].join(':');
}

/** a reused pid is deliberately treated as live, never as permission to reclaim its files. */
export function backupOwnerState(pid: number): 'absent' | 'live' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    return nodeErrorCode(error) === 'ESRCH' ? 'absent' : 'unknown';
  }
}

async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function safeDirectory(path: string, privateDirectory = false) {
  const stats = await existing(path);
  if (!stats) return undefined;
  if (
    !stats.isDirectory() ||
    (await realpath(path)) !== path ||
    (privateDirectory && (stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0))
  )
    throw new BackupError(
      'backup-cleanup-directory-unsafe',
      `unsafe backup cleanup directory: ${path}.`,
    );
  return stats;
}

async function readAttempt(path: string): Promise<{ record: BackupAttempt; stamp: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.size > 16 * 1024 * 1024 ||
      stats.nlink !== 1 ||
      stats.uid !== process.getuid?.() ||
      (stats.mode & 0o077) !== 0
    )
      throw new BackupError(
        'backup-cleanup-record-unsafe',
        `unsafe backup attempt record: ${path}.`,
      );
    const text = await handle.readFile('utf8');
    const lines = text.trimEnd().split('\n');
    const value: unknown = JSON.parse(lines.shift() ?? '');
    if (!Value.Check(attemptSchema, value))
      throw new BackupError(
        'backup-cleanup-record-invalid',
        `invalid backup attempt record: ${path}.`,
      );
    for (const line of lines) {
      const event: unknown = JSON.parse(line);
      if (Value.Check(artifactEventSchema, event)) value.artifacts.push(event.artifact);
      else if (Value.Check(writerEventSchema, event)) value.snapshotWriter = event.snapshotWriter;
      else
        throw new BackupError(
          'backup-cleanup-record-invalid',
          `invalid backup attempt event: ${path}.`,
        );
    }
    if (!Value.Check(attemptSchema, value))
      throw new BackupError(
        'backup-cleanup-record-invalid',
        `invalid backup attempt record: ${path}.`,
      );
    const stamp = fingerprint(stats);
    if (fingerprint(await handle.stat()) !== stamp || fingerprint(await lstat(path)) !== stamp)
      throw new BackupError('backup-cleanup-race', 'a backup attempt changed during inspection.');
    return { record: value, stamp };
  } finally {
    await handle.close();
  }
}

/** only a known empty or truncated gzip is demonstrably incomplete; all other archives stay. */
async function incompleteArchive(path: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return false;
    if (stats.size === 0) return true;
    const magic = Buffer.alloc(2);
    await handle.read(magic, 0, 2, 0);
    if (magic[0] !== 0x1f || (stats.size > 1 && magic[1] !== 0x8b)) return false;
    let tail = Buffer.alloc(0);
    try {
      await pipeline(
        handle.createReadStream({ start: 0, autoClose: false }),
        createGunzip(),
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            tail = Buffer.concat([tail, chunk]).subarray(-1024);
            callback();
          },
        }),
      );
      return false;
    } catch (error) {
      return (
        nodeErrorCode(error) === 'Z_BUF_ERROR' &&
        !(tail.length === 1024 && tail.every((byte) => byte === 0))
      );
    }
  } finally {
    await handle.close();
  }
}

export default async function cleanupWorkspaceBackup(options: {
  agentId: string;
  workspaceDir: string;
  output: string;
  apply: boolean;
  ownerState?: (pid: number) => 'absent' | 'live' | 'unknown';
  beforeDelete?: (path: string) => Promise<void>;
}): Promise<BackupCleanupResult> {
  const { agentId, workspaceDir, output } = options;
  const control = resolve(workspaceDir, backupControlDirectory);
  const result: BackupCleanupResult = {
    agentId,
    workspaceDir,
    output,
    wouldDelete: [],
    deleted: [],
    preserved: [],
  };
  const controlStats = await safeDirectory(control, true);
  const outputStats = await safeDirectory(output);
  if (
    (await realpath(workspaceDir)) !== workspaceDir ||
    isPathContained(output, workspaceDir) ||
    isPathContained(control, output) ||
    isPathContained(output, control)
  )
    throw new BackupError(
      'backup-cleanup-scope-invalid',
      'backup cleanup locations overlap or are not canonical.',
    );
  if (!controlStats) {
    if (outputStats)
      result.preserved = (await readdir(output)).sort().map((name) => ({
        path: join(output, name),
        reason: 'unattributed',
      }));
    return result;
  }

  const roots = [
    { path: control, stats: controlStats },
    ...(outputStats ? [{ path: output, stats: outputStats }] : []),
  ];
  const assertRoots = async () => {
    for (const root of roots) {
      const stats = await safeDirectory(root.path, root.path === control);
      if (!stats || !sameIdentity(stats, backupArtifactIdentity(root.stats)))
        throw new BackupError('backup-cleanup-race', 'a backup cleanup root changed.');
    }
  };
  const inspect = async () => {
    await assertRoots();
    const known = new Set<string>();
    const candidates: {
      path: string;
      identity: BackupArtifactIdentity;
      stamp: string;
      directory: boolean;
      recordPath: string;
      recordStamp: string;
      pid: number;
    }[] = [];
    for (const name of (await readdir(control)).sort()) {
      if (!/^attempt-[a-f0-9-]{36}\.jsonl$/u.test(name)) continue;
      const recordPath = join(control, name);
      const { record, stamp: recordStamp } = await readAttempt(recordPath);
      let refusal =
        record.agentId !== agentId ||
        record.workspaceDir !== workspaceDir ||
        record.output !== output ||
        name !== `attempt-${record.id}.jsonl`
          ? 'ownership-mismatch'
          : record.snapshotWriter
            ? 'snapshot-writer-uncertain'
            : undefined;
      const owner = (options.ownerState ?? backupOwnerState)(record.pid);
      if (!refusal && owner !== 'absent')
        refusal = owner === 'live' ? 'owner-live-or-reused' : 'owner-unknown';
      const paths = new Set(record.artifacts.map(({ path }) => path));
      if (paths.size !== record.artifacts.length) refusal = 'record-ambiguous';
      const stageRoots = record.artifacts.filter(
        ({ path }) => dirname(path) === control && /^capture-[^/]+$/u.test(basename(path)),
      );
      const groups = new Map<string, BackupAttempt['artifacts']>();
      for (const artifact of record.artifacts) {
        const { path } = artifact;
        const stageRoot = stageRoots.find((root) => isPathContained(root.path, path));
        const pending =
          dirname(path) === output && /^\.pending-[a-f0-9-]{36}\.tar\.gz$/u.test(basename(path));
        if (path !== resolve(path) || (!stageRoot && !pending)) {
          refusal = 'artifact-outside-scope';
          continue;
        }
        known.add(path);
        const group = stageRoot?.path ?? path;
        const grouped = groups.get(group) ?? [];
        grouped.push(artifact);
        groups.set(group, grouped);
      }
      for (const [root, artifacts] of groups) {
        let reason = refusal;
        const observed: typeof candidates = [];
        for (const { path, identity, archive } of artifacts) {
          const stats = await existing(path);
          if (!stats) continue;
          if (
            (await realpath(dirname(path))) !== dirname(path) ||
            !sameIdentity(stats, identity) ||
            stats.uid !== process.getuid?.() ||
            (!stats.isFile() && !stats.isDirectory()) ||
            (stats.isFile() && stats.nlink !== 1)
          ) {
            reason = 'artifact-changed';
            continue;
          }
          if (stats.isDirectory()) {
            if ((await readdir(path)).some((child) => !paths.has(join(path, child))))
              reason = 'unknown-contents';
          } else {
            const handle = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            const magic = Buffer.alloc(2);
            try {
              await handle.read(magic, 0, 2, 0);
            } finally {
              await handle.close();
            }
            if (
              (archive || /\.(?:tar|gz|tgz|zip|zst|bz2|xz|7z)$/u.test(path) || magic[0] === 0x1f) &&
              !(await incompleteArchive(path))
            )
              reason = 'complete-or-uncertain-archive';
          }
          if (fingerprint(await lstat(path)) !== fingerprint(stats)) reason = 'artifact-changed';
          observed.push({
            path,
            identity,
            stamp: fingerprint(stats),
            directory: stats.isDirectory(),
            recordPath,
            recordStamp,
            pid: record.pid,
          });
        }
        if (reason) result.preserved.push({ path: root, reason });
        else candidates.push(...observed);
      }
      if (!groups.size && refusal) result.preserved.push({ path: recordPath, reason: refusal });
    }
    for (const root of [control, ...(outputStats ? [output] : [])]) {
      for (const name of (await readdir(root)).sort()) {
        const path = join(root, name);
        if (
          known.has(path) ||
          (root === control &&
            (/^attempt-[a-f0-9-]{36}\.jsonl$/u.test(name) || name === 'capture.lock'))
        )
          continue;
        result.preserved.push({
          path,
          reason:
            root === output && !name.startsWith('.pending-')
              ? 'published-or-unrelated'
              : 'unattributed',
        });
      }
    }
    // children first; directories are removed with rmdir, never unchecked recursive deletion.
    candidates.sort(
      (a, b) => b.path.split('/').length - a.path.split('/').length || a.path.localeCompare(b.path),
    );
    if (new Set(candidates.map(({ path }) => path)).size !== candidates.length)
      throw new BackupError(
        'backup-cleanup-record-ambiguous',
        'multiple attempts claim the same artifact.',
      );
    result.wouldDelete = candidates.map(({ path }) => path);
    return candidates;
  };
  const run = async () => {
    const candidates = await inspect();
    if (!options.apply) return result;
    for (const item of candidates) {
      await options.beforeDelete?.(item.path);
      await assertRoots();
      if (
        fingerprint(await lstat(item.recordPath)) !== item.recordStamp ||
        (options.ownerState ?? backupOwnerState)(item.pid) !== 'absent' ||
        (await realpath(dirname(item.path))) !== dirname(item.path)
      )
        throw new BackupError(
          'backup-cleanup-race',
          'backup attempt ownership changed before removal.',
        );
      const stats = await lstat(item.path);
      // directory size/timestamps change as known children are removed; its inode must not.
      if (item.directory ? !sameIdentity(stats, item.identity) : fingerprint(stats) !== item.stamp)
        throw new BackupError('backup-cleanup-race', 'a backup artifact changed before removal.');
      assertPrivateStateLocksHeld();
      if (item.directory) await rmdir(item.path);
      else await unlink(item.path);
      result.deleted.push(item.path);
      result.wouldDelete = result.wouldDelete.filter((path) => path !== item.path);
    }
    return result;
  };
  try {
    if (!options.apply) return await run();
    const lock = await acquirePrivateStateFileLock(join(control, 'capture'), {
      staleMs: 30000,
      retries: { retries: 0, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
    try {
      return await withPrivateStateLock(lock, run);
    } finally {
      await lock.release();
    }
  } catch (error) {
    throw new BackupCleanupError(
      error instanceof BackupError ? error.code : (nodeErrorCode(error) ?? 'backup-cleanup-failed'),
      error instanceof Error ? error.message : 'backup cleanup stopped.',
      result,
    );
  }
}
