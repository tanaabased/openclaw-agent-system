import type { GitHubNotificationLifecycle, GitHubNotificationLifecycleId } from './types.ts';

/** Resolve one admitted item to exactly one lifecycle owner. */
export default class GitHubNotificationLifecycleRegistry {
  readonly #lifecycles: readonly GitHubNotificationLifecycle[];

  constructor(lifecycles: readonly GitHubNotificationLifecycle[]) {
    const ids = new Set<string>();
    for (const lifecycle of lifecycles) {
      if (ids.has(lifecycle.id)) {
        throw new Error(`Duplicate GitHub notification lifecycle ${lifecycle.id}.`);
      }
      ids.add(lifecycle.id);
    }
    this.#lifecycles = [...lifecycles];
  }

  resolve(id: GitHubNotificationLifecycleId): GitHubNotificationLifecycle {
    const lifecycle = this.#lifecycles.find((candidate) => candidate.id === id);
    if (!lifecycle) throw new Error(`No GitHub notification lifecycle owns ${id}.`);
    return lifecycle;
  }
}
