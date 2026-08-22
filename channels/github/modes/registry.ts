import githubNotificationWorkMode from './work.ts';
import type { GitHubNotificationMode, GitHubNotificationModeId } from './types.ts';

/** Resolve only implemented, trusted notification modes. */
export default class GitHubNotificationModeRegistry {
  readonly #modes = new Map<GitHubNotificationModeId, GitHubNotificationMode>([
    ['work', githubNotificationWorkMode],
  ]);

  resolve(id: GitHubNotificationModeId): GitHubNotificationMode {
    const mode = this.#modes.get(id);
    if (!mode) {
      throw new Error(`GitHub notification mode ${id} is not implemented.`);
    }
    return mode;
  }
}
