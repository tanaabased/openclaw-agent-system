import { dirname } from 'node:path';
import ensurePrivateStateDirectories from '../../core/ensure-private-state-directories.ts';
import acquirePrivateStateFileLock, {
  type PrivateStateFileLockOptions,
} from '../../core/private-state-file-lock.ts';
import {
  type PrivateStateLockGuard,
  withPrivateStateLock,
} from '../../core/private-state-lock-context.ts';

/** Hold ownership through an external effect and its receipt, across either storage backend. */
export default async function withWorkflowLock<T>(
  path: string,
  label: string,
  run: (guard: PrivateStateLockGuard) => Promise<T>,
  options: Partial<PrivateStateFileLockOptions> = {},
) {
  await ensurePrivateStateDirectories({
    directories: [dirname(path)],
    currentUid: process.getuid?.(),
    label,
  });
  const lock = await acquirePrivateStateFileLock(path, {
    staleMs: 30_000,
    retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    ...options,
  });
  try {
    return await withPrivateStateLock(lock, () => run(lock));
  } finally {
    await lock.release();
  }
}
