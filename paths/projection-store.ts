import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface StoredPathProjection {
  agentId: string;
  openClawPaths: string[];
  schemaVersion: 1;
  workspaceDir: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isStoredPathProjection(value: unknown): value is StoredPathProjection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredPathProjection>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.agentId === 'string' &&
    candidate.agentId.length > 0 &&
    typeof candidate.workspaceDir === 'string' &&
    candidate.workspaceDir.length > 0 &&
    Array.isArray(candidate.openClawPaths) &&
    candidate.openClawPaths.every((path) => typeof path === 'string' && path.length > 0)
  );
}

/** Persist the last Agent System-owned OpenClaw prefix outside the workspace repository. */
export default class PathProjectionStore {
  readonly #rootDir: string | undefined;

  constructor(rootDir: string | undefined) {
    this.#rootDir = rootDir ? resolve(rootDir) : undefined;
  }

  async read(agentId: string): Promise<StoredPathProjection | undefined> {
    const path = this.#path(agentId);
    if (!path) return undefined;
    try {
      const stats = await lstat(path);
      if (!stats.isFile()) throw new Error('The path projection receipt must be a regular file.');
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!isStoredPathProjection(value) || value.agentId !== agentId) {
        throw new Error('The path projection receipt is invalid.');
      }
      return value;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  async write(state: StoredPathProjection): Promise<void> {
    const path = this.#path(state.agentId);
    if (!path || !this.#rootDir) {
      throw new Error('The path projection store does not have a usable configuration directory.');
    }
    const agentDir = join(this.#rootDir, state.agentId);
    await mkdir(agentDir, { mode: 0o700, recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(state, undefined, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, path);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  #path(agentId: string): string | undefined {
    return this.#rootDir && /^[a-z0-9][a-z0-9-]*$/u.test(agentId)
      ? join(this.#rootDir, agentId, 'path-projection.json')
      : undefined;
  }
}
