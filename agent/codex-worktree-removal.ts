import { lstat } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

interface Dependencies {
  stat?: (path: string) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export default async function waitForCodexWorktreeRemoval(
  worktree: string,
  deps: Dependencies = {},
): Promise<boolean> {
  const stat = deps.stat ?? lstat;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? setTimeout;
  const deadline = now() + 30_000;
  for (;;) {
    try {
      await stat(worktree);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(1000, remaining));
  }
}
