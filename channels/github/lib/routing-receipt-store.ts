import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { githubNotificationChannelId, type NotificationRoutingReceipt } from '../utils/routing.ts';

const maximumReceiptBytes = 16 * 1024;

export interface NotificationRoutingReceiptStoreDependencies {
  currentUid?: number;
  rootDir?: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function hasPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function validAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function isReceipt(value: unknown): value is NotificationRoutingReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<NotificationRoutingReceipt>;
  const allowedKeys = new Set([
    'accountId',
    'agentId',
    'channelId',
    'schemaVersion',
    'workspaceDir',
  ]);
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    candidate.schemaVersion === 1 &&
    candidate.channelId === githubNotificationChannelId &&
    validAgentId(candidate.accountId) &&
    validAgentId(candidate.agentId) &&
    candidate.accountId === candidate.agentId &&
    typeof candidate.workspaceDir === 'string' &&
    isAbsolute(candidate.workspaceDir) &&
    resolve(candidate.workspaceDir) === candidate.workspaceDir &&
    !candidate.workspaceDir.includes('\0')
  );
}

/** Persist private proof of the exact global notification route Agent System owns. */
export default class NotificationRoutingReceiptStore {
  readonly #currentUid: number | undefined;
  readonly #rootDir: string | undefined;

  constructor(dependencies: NotificationRoutingReceiptStoreDependencies) {
    this.#currentUid = dependencies.currentUid;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
  }

  async read(agentId: string): Promise<NotificationRoutingReceipt | undefined> {
    const paths = this.#paths(agentId);
    if (!paths) return undefined;
    for (const directory of paths.directories) {
      if ((await this.#inspectDirectory(directory)) === 'missing') return undefined;
    }
    let handle;
    try {
      handle = await open(paths.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      if (errorCode(error) === 'ELOOP') {
        throw new Error('The notification routing receipt may not be a symbolic link.', {
          cause: error,
        });
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      this.#assertPrivateFile(stats);
      if (stats.size > maximumReceiptBytes) {
        throw new Error('The notification routing receipt exceeds its size limit.');
      }
      const contents = await handle.readFile();
      if (contents.byteLength > maximumReceiptBytes) {
        throw new Error('The notification routing receipt exceeds its size limit.');
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)) as unknown;
      } catch (error) {
        throw new Error('The notification routing receipt is invalid.', { cause: error });
      }
      if (!isReceipt(value) || value.agentId !== agentId) {
        throw new Error('The notification routing receipt is invalid.');
      }
      return value;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async write(receipt: NotificationRoutingReceipt): Promise<void> {
    if (!isReceipt(receipt)) throw new Error('The notification routing receipt is invalid.');
    const paths = this.#paths(receipt.agentId);
    if (!paths) {
      throw new Error('The notification routing receipt store is unavailable.');
    }
    for (const [index, directory] of paths.directories.entries()) {
      await this.#ensureDirectory(directory, index === 0);
    }
    try {
      const stats = await lstat(paths.receiptPath);
      this.#assertPrivateFile(stats);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    const temporaryPath = join(paths.agentDir, `.notification-routing.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(receipt, undefined, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, paths.receiptPath);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async remove(agentId: string): Promise<boolean> {
    const paths = this.#paths(agentId);
    if (!paths) return false;
    for (const directory of paths.directories) {
      if ((await this.#inspectDirectory(directory)) === 'missing') return false;
    }
    try {
      const stats = await lstat(paths.receiptPath);
      this.#assertPrivateFile(stats);
      await unlink(paths.receiptPath);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  #assertPrivateFile(stats: Stats): void {
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('The notification routing receipt must be a regular file.');
    }
    if (!hasPrivateMode(stats.mode)) {
      throw new Error('The notification routing receipt must be private to the current user.');
    }
    if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
      throw new Error('The notification routing receipt must be owned by the current user.');
    }
  }

  async #ensureDirectory(path: string, recursive: boolean): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700, recursive });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    if ((await this.#inspectDirectory(path)) !== 'ready') {
      throw new Error('A notification routing receipt directory is unavailable.');
    }
  }

  async #inspectDirectory(path: string): Promise<'missing' | 'ready'> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'missing';
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Notification routing receipt directories must be real directories.');
    }
    if (!hasPrivateMode(stats.mode)) {
      throw new Error('Notification routing receipt directories must be private.');
    }
    if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
      throw new Error(
        'Notification routing receipt directories must be owned by the current user.',
      );
    }
    return 'ready';
  }

  #paths(
    agentId: string,
  ): { agentDir: string; directories: string[]; receiptPath: string } | undefined {
    if (!this.#rootDir || !validAgentId(agentId)) return undefined;
    const agentDir = join(this.#rootDir, agentId);
    return {
      agentDir,
      directories: [this.#rootDir, agentDir],
      receiptPath: join(agentDir, 'notification-routing.json'),
    };
  }
}
