import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  default as acquirePrivateStateFileLock,
  privateStateFileLockBusyErrorCode,
  type PrivateStateFileLockHandle,
} from '../../../core/private-state-file-lock.ts';
import ensurePrivateStateDirectories from '../../../core/ensure-private-state-directories.ts';
import abortableDelay from '../../../utils/abortable-delay.ts';
import nodeErrorCode from '../../../utils/node-error-code.ts';

const defaultRetryMs = 250;
const defaultStaleMs = 30 * 60 * 1000;

export interface GitHubNotificationPublicationLeaseStoreDependencies {
  acquireFileLock?: typeof acquirePrivateStateFileLock;
  currentUid?: number;
  retryMs?: number;
  rootDir?: string;
  staleMs?: number;
}

/** Serialize one publication target across Gateway and CLI processes. */
export default class GitHubNotificationPublicationLeaseStore {
  readonly #acquireFileLock: typeof acquirePrivateStateFileLock;
  readonly #currentUid: number | undefined;
  readonly #retryMs: number;
  readonly #rootDir: string | undefined;
  readonly #staleMs: number;

  constructor(dependencies: GitHubNotificationPublicationLeaseStoreDependencies) {
    this.#acquireFileLock = dependencies.acquireFileLock ?? acquirePrivateStateFileLock;
    this.#currentUid = dependencies.currentUid;
    this.#retryMs = dependencies.retryMs ?? defaultRetryMs;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
    this.#staleMs = dependencies.staleMs ?? defaultStaleMs;
  }

  async exclusive<T>(
    agentId: string,
    target: string,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!this.#rootDir || !/^[a-z0-9][a-z0-9-]*$/u.test(agentId) || !target) {
      throw new Error('The GitHub notification publication lease store is unavailable.');
    }
    const agentDir = join(this.#rootDir, agentId);
    const stateDir = join(agentDir, 'channels');
    const lockDir = join(stateDir, 'github-notification-publications');
    await ensurePrivateStateDirectories({
      currentUid: this.#currentUid,
      directories: [this.#rootDir, agentDir, stateDir, lockDir],
      label: 'GitHub notification publication lease',
    });
    const digest = createHash('sha256').update(target).digest('hex');
    const path = join(lockDir, digest);
    while (true) {
      if (signal?.aborted) throw new Error('The GitHub notification publication was aborted.');
      let handle: PrivateStateFileLockHandle;
      try {
        handle = await this.#acquireFileLock(path, {
          retries: { factor: 1, maxTimeout: 0, minTimeout: 0, retries: 0 },
          staleMs: this.#staleMs,
        });
      } catch (error) {
        if (nodeErrorCode(error) !== privateStateFileLockBusyErrorCode) throw error;
        await abortableDelay(this.#retryMs, signal);
        continue;
      }
      try {
        return await run();
      } finally {
        await handle.release();
      }
    }
  }
}
