import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import isPathContained from '../utils/is-path-contained.ts';
import nodeErrorCode from '../utils/node-error-code.ts';
import { extractWorkspaceArchive, verifyWorkspaceArchive } from './backup-archive.ts';
import { canonicalBackupPath } from './backup-selection.ts';
import {
  restoreAgentSnapshot,
  verifyAgentSnapshot,
  type BackupSnapshotCommand,
} from './backup-snapshot.ts';
import {
  BackupError,
  type BackupRuntimeProtection,
  type WorkspaceBackupManifest,
} from './backup-types.ts';

async function targetLocation(
  target: string,
  protection: BackupRuntimeProtection,
): Promise<string> {
  const requested = resolve(target);
  const parent = await realpath(dirname(requested));
  const location = join(parent, basename(requested));
  if ((await canonicalBackupPath(requested)) !== location)
    throw new BackupError('backup-target-unsafe', 'The restore target cannot be a symbolic link.');
  const livePaths = [
    ...protection.paths,
    ...(protection.livePaths ?? []),
    ...(protection.agentDir ? [protection.agentDir] : []),
    ...(protection.stateDir ? [protection.stateDir] : []),
    ...(protection.workspaceDir ? [protection.workspaceDir] : []),
  ];
  for (const path of livePaths) {
    const live = await canonicalBackupPath(path);
    if (isPathContained(live, location) || isPathContained(location, live))
      throw new BackupError(
        'backup-target-live',
        'The restore target must be separate from live agent workspaces and state.',
      );
  }
  try {
    const stats = await lstat(location);
    if (!stats.isDirectory() || (stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())
      throw new BackupError(
        'backup-target-unsafe',
        'An existing restore target must be a private directory.',
      );
    if ((await readdir(location)).length !== 0)
      throw new BackupError('backup-target-nonempty', 'The restore target must be empty.');
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
  }
  return location;
}

async function copyArchive(source: string, destination: string): Promise<void> {
  const input = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await input.stat()).isFile())
      throw new BackupError('backup-archive-not-file', 'The archive must be a regular file.');
    const output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      for await (const chunk of input.createReadStream({ autoClose: false }))
        await output.writeFile(chunk);
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** restore into private staging; publish only after every payload and database operation succeeds. */
export default async function restoreWorkspaceBackup(options: {
  archive: string;
  target: string;
  expectedAgentId?: string;
  runtimeProtection(agentId: string): Promise<BackupRuntimeProtection>;
  snapshotCommand?: BackupSnapshotCommand;
}): Promise<{ target: string; manifest: WorkspaceBackupManifest; database?: string }> {
  const { archive, snapshotCommand } = options;
  const initial = await verifyWorkspaceArchive(
    archive,
    options.expectedAgentId,
    undefined,
    (directory, expected) => verifyAgentSnapshot(directory, expected, snapshotCommand),
  );
  await targetLocation(options.target, await options.runtimeProtection(initial.agentId));
  const parent = await realpath(dirname(resolve(options.target)));
  const scratch = await mkdtemp(join(parent, '.agent-system-restore-'));
  let target: string | undefined;
  let createdTarget = false;
  const published: string[] = [];
  try {
    const privateArchive = join(scratch, 'archive.tar.gz');
    await copyArchive(archive, privateArchive);
    const manifest = await verifyWorkspaceArchive(
      privateArchive,
      initial.agentId,
      undefined,
      (directory, expected) => verifyAgentSnapshot(directory, expected, snapshotCommand),
    );
    target = await targetLocation(
      options.target,
      await options.runtimeProtection(manifest.agentId),
    );
    const recovered = join(scratch, 'recovered');
    await mkdir(recovered, { mode: 0o700 });
    const snapshot = manifest.version === 2 ? manifest.snapshot : undefined;
    const snapshotDirectory = snapshot
      ? join(scratch, 'repository', snapshot.manifest.snapshotId)
      : undefined;
    if (snapshotDirectory) await mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });
    await extractWorkspaceArchive(privateArchive, recovered, manifest, snapshotDirectory);
    let database: string | undefined;
    if (snapshotDirectory) {
      const state = join(recovered, 'openclaw-state');
      await mkdir(state, { mode: 0o700 });
      await restoreAgentSnapshot(
        snapshotDirectory,
        join(state, 'openclaw-agent.sqlite'),
        snapshot!.manifest,
        snapshotCommand,
      );
      database = join(target, 'openclaw-state', 'openclaw-agent.sqlite');
    }
    try {
      await mkdir(target, { mode: 0o700 });
      createdTarget = true;
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error;
      await targetLocation(target, await options.runtimeProtection(manifest.agentId));
    }
    for (const name of await readdir(recovered)) {
      await rename(join(recovered, name), join(target, name));
      published.push(name);
    }
    return { target, manifest, ...(database ? { database } : {}) };
  } catch (error) {
    if (target) {
      for (const name of published) await rm(join(target, name), { recursive: true, force: true });
      if (createdTarget) await rm(target, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
