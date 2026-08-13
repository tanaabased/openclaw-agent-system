import { join, resolve } from 'node:path';

import {
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  acquireFileLock,
  type FileLockHandle,
} from 'openclaw/plugin-sdk/file-lock';
import { sleepWithAbort } from 'openclaw/plugin-sdk/infra-runtime';

import ensurePrivateStateDirectories from '../utils/ensure-private-state-directories.ts';

const defaultRetryMs = 250;
const defaultStaleMs = 30 * 60 * 1000;

export interface GitHubNotificationMonitorCycleLease {
  release(): Promise<void>;
}

export type GitHubNotificationMonitorCycleLeaseAcquireResult =
  | { lease: GitHubNotificationMonitorCycleLease; status: 'acquired' }
  | { status: 'aborted' | 'busy' };

export interface GitHubNotificationMonitorCycleLeaseStoreDependencies {
  acquireFileLock?: typeof acquireFileLock;
  currentUid?: number;
  retryMs?: number;
  rootDir?: string;
  staleMs?: number;
}

export interface GitHubNotificationMonitorCycleLeaseAcquireOptions {
  scope?: 'cycle' | 'publication';
  signal?: AbortSignal;
  waitMs?: number;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function validAgentId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

async function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    await sleepWithAbort(milliseconds, signal);
    return true;
  } catch (error) {
    if (signal?.aborted) return false;
    throw error;
  }
}

/** Serialize notification monitor cycles across Gateway and CLI processes. */
export default class GitHubNotificationMonitorCycleLeaseStore {
  readonly #acquireFileLock: typeof acquireFileLock;
  readonly #currentUid: number | undefined;
  readonly #retryMs: number;
  readonly #rootDir: string | undefined;
  readonly #staleMs: number;

  constructor(dependencies: GitHubNotificationMonitorCycleLeaseStoreDependencies) {
    this.#acquireFileLock = dependencies.acquireFileLock ?? acquireFileLock;
    this.#currentUid = dependencies.currentUid;
    this.#retryMs = dependencies.retryMs ?? defaultRetryMs;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
    this.#staleMs = dependencies.staleMs ?? defaultStaleMs;
  }

  async acquire(
    agentId: string,
    options: GitHubNotificationMonitorCycleLeaseAcquireOptions = {},
  ): Promise<GitHubNotificationMonitorCycleLeaseAcquireResult> {
    const waitMs = options.waitMs ?? 0;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
      throw new Error('GitHub notification cycle lease waits must be non-negative integers.');
    }
    const targetPath = await this.#targetPath(agentId, options.scope ?? 'cycle');
    const deadline = Date.now() + waitMs;
    while (true) {
      if (options.signal?.aborted) return { status: 'aborted' };
      const lease = await this.#attemptAcquire(targetPath);
      if (lease) return { lease, status: 'acquired' };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'busy' };
      if (!(await waitForRetry(Math.min(this.#retryMs, remaining), options.signal))) {
        return { status: 'aborted' };
      }
    }
  }

  async #attemptAcquire(
    targetPath: string,
  ): Promise<GitHubNotificationMonitorCycleLease | undefined> {
    let handle: FileLockHandle;
    try {
      handle = await this.#acquireFileLock(targetPath, {
        retries: {
          factor: 1,
          maxTimeout: 0,
          minTimeout: 0,
          retries: 0,
        },
        stale: this.#staleMs,
      });
    } catch (error) {
      if (errorCode(error) === FILE_LOCK_TIMEOUT_ERROR_CODE) return undefined;
      throw error;
    }
    return { release: handle.release };
  }

  async #targetPath(agentId: string, scope: 'cycle' | 'publication'): Promise<string> {
    if (!this.#rootDir || !validAgentId(agentId)) {
      throw new Error('The GitHub notification cycle lease store is unavailable.');
    }
    const agentDir = join(this.#rootDir, agentId);
    const stateDir = join(agentDir, 'channels');
    await ensurePrivateStateDirectories({
      currentUid: this.#currentUid,
      directories: [this.#rootDir, agentDir, stateDir],
      label: 'GitHub notification cycle lease',
    });
    return join(
      stateDir,
      scope === 'cycle' ? 'github-notifications' : 'github-notifications-publication',
    );
  }
}
