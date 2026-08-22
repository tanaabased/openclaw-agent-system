import type { GitHubNotificationMode, GitHubNotificationModeId } from './types.ts';

/** Resolve only implemented, trusted notification modes. */
export default class GitHubNotificationModeRegistry {
  readonly #modes: ReadonlyMap<GitHubNotificationModeId, GitHubNotificationMode>;

  constructor(modes: readonly GitHubNotificationMode[]) {
    const entries: Array<[GitHubNotificationModeId, GitHubNotificationMode]> = [];
    const ids = new Set<GitHubNotificationModeId>();
    for (const mode of modes) {
      if (ids.has(mode.policy.id)) {
        throw new Error(`Duplicate GitHub notification mode ${mode.policy.id}.`);
      }
      ids.add(mode.policy.id);
      entries.push([mode.policy.id, mode]);
    }
    this.#modes = new Map(entries);
  }

  resolve(id: GitHubNotificationModeId): GitHubNotificationMode {
    const mode = this.#modes.get(id);
    if (!mode) {
      throw new Error(`GitHub notification mode ${id} is not implemented.`);
    }
    return mode;
  }
}
