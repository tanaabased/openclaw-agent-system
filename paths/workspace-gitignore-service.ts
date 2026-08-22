import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceGitignoreBlock {
  comment: string;
  entries: readonly string[];
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`${path} must be a regular file and may not be a symbolic link.`);
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, source: string, mode: number): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function existingFileMode(path: string): Promise<number> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`${path} must be a regular file and may not be a symbolic link.`);
    }
    return stats.mode & 0o777;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0o644;
    throw error;
  }
}

function sourceEntries(source: string | undefined): Set<string> {
  return new Set(
    (source ?? '')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

/** Inspect and append owned ignore entries without replacing user-managed content. */
export default class WorkspaceGitignoreService {
  async includes(workspaceDir: string, entries: readonly string[]): Promise<boolean> {
    const source = await readRegularFile(join(workspaceDir, '.gitignore'));
    const present = sourceEntries(source);
    return entries.every((entry) => present.has(entry));
  }

  async reconcile(workspaceDir: string, block: WorkspaceGitignoreBlock): Promise<boolean> {
    const gitignorePath = join(workspaceDir, '.gitignore');
    const source = await readRegularFile(gitignorePath);
    const present = sourceEntries(source);
    const missing = block.entries.filter((entry) => !present.has(entry));
    if (missing.length === 0) return false;

    const prefix = source && !source.endsWith('\n\n') ? '\n' : '';
    const appended = `${block.comment}\n${missing.join('\n')}\n`;
    await writeAtomic(
      gitignorePath,
      `${source ?? ''}${prefix}${appended}`,
      await existingFileMode(gitignorePath),
    );
    return true;
  }
}
