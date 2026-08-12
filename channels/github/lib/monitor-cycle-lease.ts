import { constants, type Stats } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const defaultHeartbeatMs = 10_000;
const defaultRetryMs = 250;
const defaultStaleMs = 30 * 60 * 1000;
const initializationGraceMs = 5_000;
const maximumLeaseBytes = 4 * 1024;

export interface GitHubNotificationMonitorCycleLease {
  release(): Promise<void>;
}

export type GitHubNotificationMonitorCycleLeaseAcquireResult =
  | { lease: GitHubNotificationMonitorCycleLease; status: 'acquired' }
  | { status: 'aborted' | 'busy' };

export interface GitHubNotificationMonitorCycleLeaseStoreDependencies {
  currentUid?: number;
  heartbeatMs?: number;
  isProcessAlive?(pid: number): boolean;
  retryMs?: number;
  rootDir?: string;
  staleMs?: number;
}

export interface GitHubNotificationMonitorCycleLeaseAcquireOptions {
  signal?: AbortSignal;
  waitMs?: number;
}

interface LeaseRecord {
  acquiredAt: number;
  pid: number;
  schemaVersion: 1;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function hasPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function unlinkOwnedFile(path: string, ownedStats: Stats): Promise<void> {
  try {
    const currentStats = await lstat(path);
    if (sameFile(currentStats, ownedStats)) await unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function validAgentId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function decodeLeaseRecord(value: unknown): LeaseRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<LeaseRecord>;
  if (
    Object.keys(value).some((key) => !['acquiredAt', 'pid', 'schemaVersion'].includes(key)) ||
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.pid) ||
    (candidate.pid ?? 0) < 1 ||
    !Number.isSafeInteger(candidate.acquiredAt) ||
    (candidate.acquiredAt ?? 0) < 0
  ) {
    return undefined;
  }
  return candidate as LeaseRecord;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<'aborted' | 'ready'> {
  if (signal?.aborted) return Promise.resolve('aborted');
  return new Promise((resolveDelay) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolveDelay('ready');
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      resolveDelay('aborted');
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Serialize notification monitor cycles across Gateway and CLI processes. */
export default class GitHubNotificationMonitorCycleLeaseStore {
  readonly #currentUid: number | undefined;
  readonly #heartbeatMs: number;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #retryMs: number;
  readonly #rootDir: string | undefined;
  readonly #staleMs: number;

  constructor(dependencies: GitHubNotificationMonitorCycleLeaseStoreDependencies) {
    this.#currentUid = dependencies.currentUid;
    this.#heartbeatMs = dependencies.heartbeatMs ?? defaultHeartbeatMs;
    this.#isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
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
    const paths = await this.#paths(agentId);
    const deadline = Date.now() + waitMs;
    while (true) {
      if (options.signal?.aborted) return { status: 'aborted' };
      const lease = await this.#attemptAcquire(paths.lockPath);
      if (lease) return { lease, status: 'acquired' };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'busy' };
      if ((await delay(Math.min(this.#retryMs, remaining), options.signal)) === 'aborted') {
        return { status: 'aborted' };
      }
    }
  }

  async #attemptAcquire(
    lockPath: string,
  ): Promise<GitHubNotificationMonitorCycleLease | undefined> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        lockPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (await this.#reclaim(lockPath)) return this.#attemptAcquire(lockPath);
      return undefined;
    }
    const record: LeaseRecord = {
      acquiredAt: Date.now(),
      pid: process.pid,
      schemaVersion: 1,
    };
    const ownedStats = await handle.stat();
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      const heartbeat = setInterval(() => {
        const now = new Date();
        void handle?.utimes(now, now).catch(() => undefined);
      }, this.#heartbeatMs);
      heartbeat.unref();
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try {
            await unlinkOwnedFile(lockPath, ownedStats);
          } finally {
            await handle?.close();
          }
        },
      };
    } catch (error) {
      await unlinkOwnedFile(lockPath, ownedStats).catch(() => undefined);
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #reclaim(lockPath: string): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      if (errorCode(error) === 'ELOOP') {
        throw new Error('The GitHub notification cycle lease may not be a symbolic link.', {
          cause: error,
        });
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      this.#assertPrivateFile(stats);
      if (stats.size > maximumLeaseBytes) {
        throw new Error('The GitHub notification cycle lease exceeds its size limit.');
      }
      const contents = await handle.readFile('utf8');
      let record: LeaseRecord | undefined;
      try {
        record = decodeLeaseRecord(JSON.parse(contents));
      } catch {
        record = undefined;
      }
      const age = Date.now() - stats.mtimeMs;
      const reclaimable = record
        ? !this.#isProcessAlive(record.pid) || age >= this.#staleMs
        : age >= initializationGraceMs;
      if (!reclaimable) return false;
      const currentStats = await lstat(lockPath);
      if (!sameFile(currentStats, stats)) return true;
      await unlink(lockPath);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  #assertPrivateFile(stats: Stats): void {
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('The GitHub notification cycle lease must be a regular file.');
    }
    if (!hasPrivateMode(stats.mode)) {
      throw new Error('The GitHub notification cycle lease must be private.');
    }
    if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
      throw new Error('The GitHub notification cycle lease must be owned by the current user.');
    }
  }

  async #paths(agentId: string): Promise<{ lockPath: string }> {
    if (!this.#rootDir || !validAgentId(agentId)) {
      throw new Error('The GitHub notification cycle lease store is unavailable.');
    }
    const agentDir = join(this.#rootDir, agentId);
    const stateDir = join(agentDir, 'channels');
    await this.#ensureDirectory(this.#rootDir, true);
    await this.#ensureDirectory(agentDir, false);
    await this.#ensureDirectory(stateDir, false);
    return { lockPath: join(stateDir, 'github-notifications.lock') };
  }

  async #ensureDirectory(path: string, recursive: boolean): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700, recursive });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('GitHub notification cycle lease directories must be real directories.');
    }
    if (!hasPrivateMode(stats.mode)) {
      throw new Error('GitHub notification cycle lease directories must be private.');
    }
    if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
      throw new Error(
        'GitHub notification cycle lease directories must be owned by the current user.',
      );
    }
  }
}
