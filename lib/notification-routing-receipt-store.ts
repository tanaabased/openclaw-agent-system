import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  githubNotificationChannelId,
  type NotificationRoutingReceipt,
} from '../utils/notification-routing.ts';

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isReceipt(value: unknown): value is NotificationRoutingReceipt {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NotificationRoutingReceipt>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.channelId === githubNotificationChannelId &&
    typeof candidate.accountId === 'string' &&
    candidate.accountId.length > 0 &&
    typeof candidate.agentId === 'string' &&
    candidate.agentId.length > 0 &&
    typeof candidate.workspaceDir === 'string' &&
    candidate.workspaceDir.length > 0
  );
}

/** Persist private proof of the exact global notification route Agent System owns. */
export default class NotificationRoutingReceiptStore {
  readonly #rootDir: string | undefined;

  constructor(rootDir: string | undefined) {
    this.#rootDir = rootDir ? resolve(rootDir) : undefined;
  }

  async read(agentId: string): Promise<NotificationRoutingReceipt | undefined> {
    const path = this.#path(agentId);
    if (!path) return undefined;
    try {
      const stats = await lstat(path);
      if (!stats.isFile()) {
        throw new Error('The notification routing receipt must be a regular file.');
      }
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!isReceipt(value) || value.agentId !== agentId || value.accountId !== agentId) {
        throw new Error('The notification routing receipt is invalid.');
      }
      return value;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  async write(receipt: NotificationRoutingReceipt): Promise<void> {
    const path = this.#path(receipt.agentId);
    if (!path || !this.#rootDir) {
      throw new Error('The notification routing receipt store is unavailable.');
    }
    const agentDir = join(this.#rootDir, receipt.agentId);
    await mkdir(agentDir, { mode: 0o700, recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
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
      await rename(temporaryPath, path);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async remove(agentId: string): Promise<boolean> {
    const path = this.#path(agentId);
    if (!path) return false;
    try {
      const stats = await lstat(path);
      if (!stats.isFile()) {
        throw new Error('The notification routing receipt must be a regular file.');
      }
      await unlink(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  #path(agentId: string): string | undefined {
    return this.#rootDir && /^[a-z0-9][a-z0-9-]*$/u.test(agentId)
      ? join(this.#rootDir, agentId, 'notification-routing.json')
      : undefined;
  }
}
