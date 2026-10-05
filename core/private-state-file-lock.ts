import { createRequire } from 'node:module';

import nodeErrorCode from '../utils/node-error-code.ts';
import type { PrivateStateLockGuard } from './private-state-lock-context.ts';

export const privateStateFileLockBusyErrorCode = 'private-state-file-lock-busy';
export const privateStateFileLockLostErrorCode = 'private-state-file-lock-lost';

export interface PrivateStateFileLockHandle extends PrivateStateLockGuard {
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
      onCompromised(error: Error): void;
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
  dependencies: { lock?: ProperLockfile['lock'] } = {},
): Promise<PrivateStateFileLockHandle> {
  if (!path || !Number.isSafeInteger(options.staleMs) || options.staleMs < 2_000) {
    throw new Error('Private state file lock options are invalid.');
  }
  const controller = new AbortController();
  let lost: Error | undefined;
  let releasing: Promise<void> | undefined;
  const assertHeld = () => {
    if (lost) throw lost;
    if (releasing) throw new Error('The private state file lock has been released.');
  };
  try {
    const release = await (dependencies.lock ?? properLockfile.lock)(path, {
      onCompromised() {
        // library callbacks run outside the acquisition promise; never throw from this boundary.
        lost ??= Object.assign(
          new Error('The private state file lock was lost; retry the operation.'),
          {
            code: privateStateFileLockLostErrorCode,
          },
        );
        controller.abort(lost);
      },
      realpath: false,
      retries: options.retries,
      stale: options.staleMs,
    });
    return {
      assertHeld,
      signal: controller.signal,
      release() {
        // a compromised lease no longer owns the lock directory. leave its successor alone.
        releasing ??= Promise.resolve().then(() => (lost ? undefined : release()));
        return releasing;
      },
    };
  } catch (error) {
    if (nodeErrorCode(error) !== 'ELOCKED') throw error;
    throw Object.assign(new Error('The private state file lock is busy.'), {
      code: privateStateFileLockBusyErrorCode,
    });
  }
}
