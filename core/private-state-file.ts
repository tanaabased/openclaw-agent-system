import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import nodeErrorCode from '../utils/node-error-code.ts';
import ensurePrivateStateDirectories from './ensure-private-state-directories.ts';

export interface PrivateStateFileOptions {
  currentUid?: number;
  directories: string[];
  label: string;
  maximumBytes: number;
  path: string;
}

function hasPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/** Read and atomically replace one privately owned UTF-8 state file. */
export default class PrivateStateFile {
  readonly #currentUid: number | undefined;
  readonly #directories: string[];
  readonly #label: string;
  readonly #maximumBytes: number;
  readonly #path: string;

  constructor(options: PrivateStateFileOptions) {
    this.#currentUid = options.currentUid;
    this.#directories = options.directories;
    this.#label = options.label;
    this.#maximumBytes = options.maximumBytes;
    this.#path = options.path;
  }

  async read(): Promise<string | undefined> {
    for (const directory of this.#directories) {
      if ((await this.#inspectDirectory(directory)) === 'missing') return undefined;
    }
    let handle;
    try {
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return undefined;
      if (nodeErrorCode(error) === 'ELOOP') {
        throw new Error(`The ${this.#label} may not be a symbolic link.`, { cause: error });
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      this.#assertPrivateFile(stats);
      if (stats.size > this.#maximumBytes) this.#sizeError();
      const contents = await handle.readFile();
      if (contents.byteLength > this.#maximumBytes) this.#sizeError();
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(contents);
      } catch (error) {
        throw new Error(`The ${this.#label} is invalid.`, { cause: error });
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async write(contents: string): Promise<void> {
    if (Buffer.byteLength(contents) > this.#maximumBytes) this.#sizeError();
    await ensurePrivateStateDirectories({
      currentUid: this.#currentUid,
      directories: this.#directories,
      label: `${this.#label.charAt(0).toUpperCase()}${this.#label.slice(1)}`,
    });
    try {
      this.#assertPrivateFile(await lstat(this.#path));
    } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') throw error;
    }

    const temporaryPath = join(dirname(this.#path), `.${basename(this.#path)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#path);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async remove(): Promise<boolean> {
    for (const directory of this.#directories) {
      if ((await this.#inspectDirectory(directory)) === 'missing') return false;
    }
    try {
      this.#assertPrivateFile(await lstat(this.#path));
      await unlink(this.#path);
      return true;
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  #assertPrivateFile(stats: Stats): void {
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`The ${this.#label} must be a regular file.`);
    }
    if (!hasPrivateMode(stats.mode)) {
      throw new Error(`The ${this.#label} must be private to the current user.`);
    }
    if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
      throw new Error(`The ${this.#label} must be owned by the current user.`);
    }
  }

  async #inspectDirectory(path: string): Promise<'missing' | 'ready'> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return 'missing';
      throw error;
    }
    const label = `${this.#label.charAt(0).toUpperCase()}${this.#label.slice(1)}`;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${label} directories must be real directories.`);
    }
    if (!hasPrivateMode(stats.mode)) {
      throw new Error(`${label} directories must be private.`);
    }
    if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
      throw new Error(`${label} directories must be owned by the current user.`);
    }
    return 'ready';
  }

  #sizeError(): never {
    throw new Error(`The ${this.#label} exceeds its size limit.`);
  }
}
