import { join, resolve } from 'node:path';

import {
  default as acquirePrivateStateFileLock,
  privateStateFileLockBusyErrorCode,
  type PrivateStateFileLockHandle,
} from '../../../../core/private-state-file-lock.ts';
import ensurePrivateStateDirectories from '../../../../core/ensure-private-state-directories.ts';
import abortableDelay from '../../../../utils/abortable-delay.ts';
import nodeErrorCode from '../../../../utils/node-error-code.ts';

const defaultRetryMs = 250;
const defaultStaleMs = 30 * 60 * 1000;

export interface GitHubNotificationMonitorCycleLease {
  release(): Promise<void>;
}

export type GitHubNotificationMonitorCycleLeaseAcquireResult =
  | { lease: GitHubNotificationMonitorCycleLease; status: 'acquired' }
  | { status: 'aborted' | 'busy' };

export interface GitHubNotificationMonitorCycleLeaseStoreDependencies {
  acquireFileLock?: typeof acquirePrivateStateFileLock;
  currentUid?: number;
  retryMs?: number;
  rootDir?: string;
  staleMs?: number;
}

export interface GitHubNotificationMonitorCycleLeaseAcquireOptions {
  scope?: 'execution' | 'poll';
  signal?: AbortSignal;
  waitMs?: number;
}

function validAgentId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

async function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    await abortableDelay(milliseconds, signal);
    return true;
  } catch (error) {
    if (signal?.aborted) return false;
    throw error;
  }
}

/** Independently serialize polling and execution across Gateway and CLI processes. */
export default class GitHubNotificationMonitorCycleLeaseStore {
  readonly #acquireFileLock: typeof acquirePrivateStateFileLock;
  readonly #currentUid: number | undefined;
  readonly #retryMs: number;
  readonly #rootDir: string | undefined;
  readonly #staleMs: number;

  constructor(dependencies: GitHubNotificationMonitorCycleLeaseStoreDependencies) {
    this.#acquireFileLock = dependencies.acquireFileLock ?? acquirePrivateStateFileLock;
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
    const targetPath = await this.#targetPath(agentId, options.scope ?? 'poll');
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
    let handle: PrivateStateFileLockHandle;
    try {
      handle = await this.#acquireFileLock(targetPath, {
        retries: {
          factor: 1,
          maxTimeout: 0,
          minTimeout: 0,
          retries: 0,
        },
        staleMs: this.#staleMs,
      });
    } catch (error) {
      if (nodeErrorCode(error) === privateStateFileLockBusyErrorCode) return undefined;
      throw error;
    }
    return { release: handle.release };
  }

  async #targetPath(agentId: string, scope: 'execution' | 'poll'): Promise<string> {
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
      scope === 'execution' ? 'github-notification-execution' : 'github-notifications',
    );
  }
}
