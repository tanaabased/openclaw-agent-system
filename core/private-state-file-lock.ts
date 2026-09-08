import { createRequire } from 'node:module';

import nodeErrorCode from '../utils/node-error-code.ts';

export const privateStateFileLockBusyErrorCode = 'private-state-file-lock-busy';

export interface PrivateStateFileLockHandle {
  release(): Promise<void>;
}

export interface PrivateStateFileLockRetryOptions {
  factor: number;
  maxTimeout: number;
  minTimeout: number;
  retries: number;
}

export interface PrivateStateFileLockOptions {
  retries: PrivateStateFileLockRetryOptions;
  staleMs: number;
}

interface ProperLockfile {
  lock(
    path: string,
    options: {
      realpath: false;
      retries: PrivateStateFileLockRetryOptions;
      stale: number;
    },
  ): Promise<() => Promise<void>>;
}

const properLockfile = createRequire(import.meta.url)('proper-lockfile') as ProperLockfile;

/** Acquire an atomic cross-process lease without exposing the lock library to callers. */
export default async function acquirePrivateStateFileLock(
  path: string,
  options: PrivateStateFileLockOptions,
): Promise<PrivateStateFileLockHandle> {
  if (!path || !Number.isSafeInteger(options.staleMs) || options.staleMs < 2_000) {
    throw new Error('Private state file lock options are invalid.');
  }
  try {
    const release = await properLockfile.lock(path, {
      realpath: false,
      retries: options.retries,
      stale: options.staleMs,
    });
    return { release };
  } catch (error) {
    if (nodeErrorCode(error) !== 'ELOCKED') throw error;
    throw Object.assign(new Error('The private state file lock is busy.'), {
      code: privateStateFileLockBusyErrorCode,
    });
  }
}
