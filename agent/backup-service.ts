import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import isPathContained from '../utils/is-path-contained.ts';
import nodeErrorCode from '../utils/node-error-code.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { BackupConfiguration } from '../manifest/backup-schema.ts';
import {
  captureAgentSnapshot,
  verifyAgentSnapshot,
  type BackupSnapshotCommand,
} from './backup-snapshot.ts';
import {
  writeWorkspaceArchive,
  verifyWorkspaceArchive,
  readWorkspaceArchiveMetadata,
  safeBackupLink,
} from './backup-archive.ts';
import restoreWorkspaceBackup from './backup-restore.ts';
import {
  backupGit,
  backupPathProtected,
  canonicalBackupPath,
  planWorkspaceBackup,
} from './backup-selection.ts';
import {
  BackupError,
  backupControlDirectory,
  type BackupEntry,
  type BackupPlan,
  type BackupRuntimeProtection,
  type WorkspaceBackupManifest,
} from './backup-types.ts';

const lockOptions = {
  retries: { factor: 1, maxTimeout: 100, minTimeout: 100, retries: 100 },
  staleMs: 30_000,
};

/** create through real directories only; do not chmod or reuse an unsafe staging directory. */
async function ensureDirectory(path: string, privateDirectory = false): Promise<void> {
  try {
    const stats = await lstat(path);
    if (
      !stats.isDirectory() ||
      (await realpath(path)) !== path ||
      (privateDirectory && ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()))
    )
      throw new BackupError('backup-directory-unsafe', `Unsafe backup directory: ${path}.`);
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
    await ensureDirectory(dirname(path));
    await mkdir(path, { mode: 0o700 }).catch((failure) => {
      if (nodeErrorCode(failure) !== 'EEXIST') throw failure;
    });
    await ensureDirectory(path, privateDirectory);
  }
}

/** append an exact local destination rule and verify Git actually applies it before writing. */
async function ignoreDestination(workspaceDir: string, destination: string): Promise<void> {
  let root: string;
  try {
    root = (await backupGit(workspaceDir, ['rev-parse', '--show-toplevel'])).stdout.trim();
  } catch (error) {
    if (
      (error as { code?: number; stderr?: string }).code === 128 &&
      (error as { stderr?: string }).stderr?.includes('not a git repository')
    )
      return;
    throw new BackupError(
      'backup-git-metadata-unavailable',
      'The repository ignore metadata could not be inspected.',
    );
  }
  root = await realpath(root);
  if (!isPathContained(root, destination)) return;
  const path = relative(root, destination).split('\\').join('/');
  if (!path || path.includes('\r') || path.includes('\n') || path.includes('\0'))
    throw new BackupError(
      'backup-ignore-path-invalid',
      'The destination cannot be represented as a scoped Git-ignore rule.',
    );
  const tracked = await backupGit(root, ['ls-files', '-z', '--', path]);
  if (tracked.stdout)
    throw new BackupError(
      'backup-destination-tracked',
      'The backup destination already contains tracked files. Choose an untracked destination.',
    );
  const metadata = await backupGit(root, ['rev-parse', '--absolute-git-dir']);
  if (isPathContained(await realpath(metadata.stdout.trim()), destination))
    throw new BackupError(
      'backup-output-is-git-metadata',
      'The destination cannot be inside Git metadata.',
    );
  const probe = `${path}/.agent-system-backup-probe`;
  const ignored = async () => {
    try {
      await backupGit(root, ['check-ignore', '--no-index', '--quiet', '--', probe]);
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  };
  if (await ignored()) return;
  const exclude = (
    await backupGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])
  ).stdout.trim();
  await ensureDirectory(dirname(exclude));
  const canonical = await canonicalBackupPath(exclude);
  if (canonical !== exclude)
    throw new BackupError(
      'backup-ignore-file-unsafe',
      'The local Git exclude file cannot be a symbolic link.',
    );
  const handle = await open(
    exclude,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new BackupError(
        'backup-ignore-file-unsafe',
        'The local Git exclude path must be a regular file.',
      );
    const rule = `/${path.replace(/[\\*?[\] ]/gu, '\\$&')}/`;
    await handle.writeFile(`\n# agent system workspace backups\n${rule}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!(await ignored()))
    throw new BackupError(
      'backup-ignore-rule-overridden',
      'A repository ignore rule overrides the local backup rule. Ignore this destination explicitly before retrying.',
    );
}

function fingerprint(stats: Awaited<ReturnType<typeof lstat>>) {
  return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeMs, stats.ctimeMs].join(':');
}

export interface BackupPruneResult {
  agentId: string;
  output: string;
  keep: number;
  kept: string[];
  deleted: string[];
  wouldDelete: string[];
  skipped: { path: string; reason: string }[];
}

export class BackupPruneError extends BackupError {
  constructor(
    code: string,
    message: string,
    public readonly result: BackupPruneResult,
  ) {
    super(code, message);
  }
}

async function captureWorkspace(
  plan: BackupPlan,
  stage: string,
  signal?: AbortSignal,
): Promise<{ inventory: BackupEntry[]; sources: Map<string, string> }> {
  const inventory: BackupEntry[] = [];
  const sources = new Map<string, string>([
    [plan.workspaceDir, fingerprint(await lstat(plan.workspaceDir))],
  ]);
  for (const path of plan.files) {
    signal?.throwIfAborted();
    const source = join(plan.workspaceDir, path);
    const destination = join(stage, path);
    try {
      const parent = await realpath(dirname(source));
      if (!isPathContained(plan.workspaceDir, parent) || parent !== dirname(source))
        throw new BackupError(
          'backup-source-escaped',
          `A source directory changed during capture: ${path}.`,
        );
      const canonical = await canonicalBackupPath(source);
      if (
        backupPathProtected(source, plan.protectedPaths) ||
        backupPathProtected(canonical, plan.protectedPaths)
      )
        throw new BackupError(
          'backup-source-protected',
          `A selected source became protected: ${path}.`,
        );
      const before = await lstat(source);
      sources.set(source, fingerprint(before));
      const mode = before.mode & 0o777;
      if (before.isDirectory()) {
        await mkdir(destination, { mode: 0o700 });
        inventory.push({ path, type: 'directory', size: 0, mode });
      } else if (before.isSymbolicLink()) {
        const linkTarget = await readlink(source);
        if (
          !safeBackupLink(path, linkTarget) ||
          fingerprint(before) !== fingerprint(await lstat(source))
        )
          throw new BackupError(
            'backup-link-changed',
            `A link is unsafe or changed during capture: ${path}.`,
          );
        inventory.push({ path, type: 'symlink', mode, size: 0, linkTarget });
      } else if (before.isFile()) {
        const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        let targetHandle: FileHandle | undefined;
        const hash = createHash('sha256');
        let size = 0;
        try {
          targetHandle = await open(
            destination,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          if (fingerprint(before) !== fingerprint(await sourceHandle.stat()))
            throw new BackupError(
              'backup-source-changed',
              `A file changed before capture: ${path}.`,
            );
          for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
            signal?.throwIfAborted();
            hash.update(chunk);
            size += chunk.length;
            await targetHandle.writeFile(chunk);
          }
          await targetHandle.sync();
          if (
            size !== before.size ||
            fingerprint(before) !== fingerprint(await sourceHandle.stat()) ||
            fingerprint(before) !== fingerprint(await lstat(source))
          )
            throw new BackupError(
              'backup-source-changed',
              `A file changed during capture: ${path}. No archive was published.`,
            );
        } finally {
          await sourceHandle.close();
          await targetHandle?.close();
        }
        inventory.push({ path, type: 'file', mode, size, sha256: hash.digest('hex') });
      } else
        throw new BackupError(
          'backup-source-type-unsupported',
          `A source entry changed type during capture: ${path}.`,
        );
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT')
        throw new BackupError(
          'backup-source-lost',
          `A selected file disappeared during capture: ${path}. No archive was published.`,
        );
      throw error;
    }
  }
  return { inventory, sources };
}

export default class WorkspaceBackupService {
  constructor(
    private readonly runtimeProtection: (
      agentId: string,
    ) => Promise<BackupRuntimeProtection> = async () => ({ paths: [] }),
    private readonly snapshotCommand?: BackupSnapshotCommand,
    private readonly beforePruneDelete?: (path: string) => Promise<void>,
  ) {}

  async prune(options: {
    manifest: AgentManifest;
    workspaceDir: string;
    output?: string;
    keep: number;
    dryRun: boolean;
    bound?: boolean;
  }): Promise<BackupPruneResult> {
    if (!Number.isSafeInteger(options.keep) || options.keep < 1)
      throw new BackupError('backup-keep-invalid', 'Supply --keep as a positive integer.');
    const plan = await this.plan({
      manifest: options.manifest,
      workspaceDir: options.workspaceDir,
      overrides: options.output ? { output: options.output } : {},
      bound: options.bound,
    });
    const output = plan.settings.output;
    const control = await canonicalBackupPath(resolve(plan.workspaceDir, backupControlDirectory));
    const empty = (): BackupPruneResult => ({
      agentId: plan.agentId,
      output,
      keep: options.keep,
      kept: [],
      deleted: [],
      wouldDelete: [],
      skipped: [],
    });
    const inspect = async () => {
      const result = empty();
      let names: string[];
      try {
        const directory = await lstat(output);
        if (!directory.isDirectory() || (await realpath(output)) !== output)
          throw new BackupError(
            'backup-directory-unsafe',
            'The backup destination is not a real directory.',
          );
        names = (await readdir(output)).sort();
      } catch (error) {
        if (nodeErrorCode(error) === 'ENOENT')
          return { result, eligible: [] as { path: string; stamp: string; identity: string }[] };
        throw error;
      }
      const eligible: { path: string; stamp: string; identity: string }[] = [];
      for (const name of names) {
        const path = join(output, name);
        let stats: Awaited<ReturnType<typeof lstat>>;
        try {
          stats = await lstat(path);
        } catch {
          result.skipped.push({ path, reason: 'unreadable' });
          continue;
        }
        if (!stats.isFile()) {
          result.skipped.push({ path, reason: 'not-regular-file' });
          continue;
        }
        if (name.startsWith('.pending-')) {
          result.skipped.push({ path, reason: 'pending-write' });
          continue;
        }
        if (!name.endsWith('.tar.gz')) {
          result.skipped.push({ path, reason: 'unrelated-file' });
          continue;
        }
        try {
          const metadata = await readWorkspaceArchiveMetadata(path);
          if (fingerprint(await lstat(path)) !== fingerprint(stats))
            throw new BackupError(
              'backup-archive-changed',
              'The archive changed during inspection.',
            );
          if (metadata.agentId !== plan.agentId) {
            result.skipped.push({ path, reason: 'other-agent' });
            continue;
          }
          eligible.push({ path, stamp: metadata.capturedAt, identity: fingerprint(stats) });
        } catch (error) {
          result.skipped.push({
            path,
            reason: error instanceof BackupError ? error.code : 'unreadable',
          });
        }
      }
      eligible.sort((a, b) => b.stamp.localeCompare(a.stamp) || a.path.localeCompare(b.path));
      return { result, eligible };
    };
    const run = async () => {
      const { result, eligible } = await inspect();
      for (let index = 0; index < eligible.length; index++) {
        const item = eligible[index]!;
        try {
          await this.verify(item.path, plan.agentId);
          if (fingerprint(await lstat(item.path)) !== item.identity)
            throw new BackupError(
              'backup-archive-changed',
              'The archive changed during verification.',
            );
        } catch (error) {
          const code = error instanceof BackupError ? error.code : 'backup-archive-invalid';
          if (result.kept.length < options.keep) {
            result.skipped.push({
              path: item.path,
              reason: `retained-verification-failed:${code}`,
            });
            throw new BackupPruneError(
              'backup-retained-verification-failed',
              `A proposed retained archive failed verification: ${item.path} (${code}).`,
              result,
            );
          }
          result.skipped.push({ path: item.path, reason: code });
          continue;
        }
        if (result.kept.length < options.keep) result.kept.push(item.path);
        else result.wouldDelete.push(item.path);
      }
      if (options.dryRun || result.wouldDelete.length === 0) return result;
      const original = new Map(eligible.map((entry) => [entry.path, entry]));
      const remaining = [...eligible];
      for (const path of [...result.wouldDelete]) {
        try {
          await this.beforePruneDelete?.(path);
          const fresh = await inspect();
          const old = original.get(path)!;
          if (
            fresh.eligible.length !== remaining.length ||
            fresh.eligible.some(
              (entry, index) =>
                entry.path !== remaining[index]!.path ||
                entry.identity !== remaining[index]!.identity,
            ) ||
            fingerprint(await lstat(path)) !== old.identity
          )
            throw new BackupError(
              'backup-prune-race',
              'Archive selection changed before deletion.',
            );
          await unlink(path);
          remaining.splice(
            remaining.findIndex((entry) => entry.path === path),
            1,
          );
          result.deleted.push(path);
          result.wouldDelete = result.wouldDelete.filter((entry) => entry !== path);
        } catch (error) {
          throw new BackupPruneError(
            error instanceof BackupError ? error.code : 'backup-prune-delete-failed',
            `Pruning stopped at ${path}: ${error instanceof Error ? error.message : String(error)}.`,
            result,
          );
        }
      }
      return result;
    };
    if (options.dryRun) return run();
    // apply uses the same lease as creation; dry-run must not create staging or lock state.
    await ignoreDestination(plan.workspaceDir, control);
    await ignoreDestination(plan.workspaceDir, output);
    await ensureDirectory(control, true);
    const lock = await acquirePrivateStateFileLock(join(control, 'capture'), lockOptions);
    try {
      return await run();
    } finally {
      await lock.release();
    }
  }

  async plan(options: {
    manifest: AgentManifest;
    workspaceDir: string;
    overrides?: BackupConfiguration;
    bound?: boolean;
  }): Promise<BackupPlan> {
    return planWorkspaceBackup({
      ...options,
      runtimeProtection: await this.runtimeProtection(options.manifest.agent.id),
    });
  }

  async create(plan: BackupPlan, signal?: AbortSignal) {
    const control = await canonicalBackupPath(resolve(plan.workspaceDir, backupControlDirectory));
    if (!isPathContained(plan.workspaceDir, control))
      throw new BackupError(
        'backup-staging-outside-workspace',
        'The staging directory must remain inside the selected workspace.',
      );
    await ignoreDestination(plan.workspaceDir, control);
    await ensureDirectory(control, true);
    const lock = await acquirePrivateStateFileLock(join(control, 'capture'), lockOptions);
    let stage: string | undefined;
    try {
      signal?.throwIfAborted();
      // refresh selection under the lease after concurrent creation and ignore changes.
      const fresh = await this.plan({
        manifest: { schemaVersion: 1, agent: { id: plan.agentId }, backup: plan.settings },
        workspaceDir: plan.workspaceDir,
        overrides: plan.settings,
      });
      await ignoreDestination(plan.workspaceDir, fresh.settings.output);
      await ensureDirectory(fresh.settings.output);
      stage = await mkdtemp(join(control, 'capture-'));
      const payload = join(stage, 'workspace');
      await mkdir(payload, { mode: 0o700 });
      const captured = await captureWorkspace(fresh, payload, signal);
      const snapshot = await captureAgentSnapshot(fresh, stage, this.snapshotCommand);
      const coverage = {
        ...fresh.coverage,
        stage:
          snapshot.state === 'captured'
            ? ('workspace-and-agent-state' as const)
            : ('workspace-only' as const),
        openclawState: snapshot.state,
        limitations: [
          ...fresh.coverage.limitations,
          ...(snapshot.state === 'absent'
            ? ['The selected OpenClaw agent database did not exist at capture time.']
            : []),
          ...(snapshot.state === 'captured'
            ? ['OpenClaw omits transient agent database lease rows from its snapshot.']
            : []),
        ],
      };
      const agentSystemVersion = (
        JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version;
      const manifest: WorkspaceBackupManifest = {
        format: 'agent-system-backup',
        version: 2,
        agentId: fresh.agentId,
        capturedAt: new Date().toISOString(),
        settings: fresh.settings,
        coverage,
        diagnostics: fresh.diagnostics,
        inventory: captured.inventory,
        ...(snapshot.manifest
          ? {
              snapshot: {
                manifest: snapshot.manifest,
                openclawVersion: fresh.openclawVersion ?? 'unavailable',
                agentSystemVersion,
              },
            }
          : {}),
      };
      const temporaryArchive = join(stage, 'archive.tar.gz');
      await writeWorkspaceArchive(temporaryArchive, payload, manifest, signal, snapshot.directory);
      await this.verify(temporaryArchive, plan.agentId, signal);
      const destination = join(
        fresh.settings.output,
        `${plan.agentId}-${manifest.capturedAt.replace(/[:.]/gu, '-')}-${randomUUID()}.tar.gz`,
      );
      // copy to the destination filesystem privately, then use an exclusive hard link to publish.
      const pending = join(fresh.settings.output, `.pending-${randomUUID()}.tar.gz`);
      try {
        const source = await open(temporaryArchive, 'r');
        let target: FileHandle | undefined;
        try {
          target = await open(
            pending,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          for await (const chunk of source.createReadStream({ autoClose: false })) {
            signal?.throwIfAborted();
            await target.writeFile(chunk);
          }
          await target.sync();
        } finally {
          await source.close();
          await target?.close();
        }
        await this.verify(pending, plan.agentId, signal);
        await ensureDirectory(fresh.settings.output);
        signal?.throwIfAborted();
        for (const [source, expected] of captured.sources) {
          try {
            if (
              fingerprint(await lstat(source)) !== expected ||
              (await realpath(dirname(source))) !== dirname(source)
            )
              throw new BackupError(
                'backup-source-changed',
                `A source changed before publication: ${relative(fresh.workspaceDir, source) || '.'}. No archive was published.`,
              );
          } catch (error) {
            if (nodeErrorCode(error) === 'ENOENT')
              throw new BackupError(
                'backup-source-lost',
                `A source disappeared before publication: ${relative(fresh.workspaceDir, source)}. No archive was published.`,
              );
            throw error;
          }
        }
        await link(pending, destination);
      } finally {
        await unlink(pending).catch(() => undefined);
      }
      return { archive: destination, manifest };
    } finally {
      if (stage) await rm(stage, { recursive: true, force: true });
      await lock.release();
    }
  }

  async verify(archive: string, agentId?: string, signal?: AbortSignal) {
    return verifyWorkspaceArchive(archive, agentId, signal, (directory, manifest) =>
      verifyAgentSnapshot(directory, manifest, this.snapshotCommand),
    );
  }

  async restore(archive: string, target: string, agentId?: string) {
    return restoreWorkspaceBackup({
      archive,
      target,
      ...(agentId ? { expectedAgentId: agentId } : {}),
      runtimeProtection: this.runtimeProtection,
      ...(this.snapshotCommand ? { snapshotCommand: this.snapshotCommand } : {}),
    });
  }
}
