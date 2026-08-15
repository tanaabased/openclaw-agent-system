import githubNotificationWorkCapability from './work.ts';
import type { GitHubNotificationCapability, GitHubNotificationCapabilityId } from './types.ts';

/** Resolve only implemented, trusted notification capabilities. */
export default class GitHubNotificationCapabilityRegistry {
  readonly #capabilities = new Map<GitHubNotificationCapabilityId, GitHubNotificationCapability>([
    ['work', githubNotificationWorkCapability],
  ]);

  resolve(id: GitHubNotificationCapabilityId): GitHubNotificationCapability {
    const capability = this.#capabilities.get(id);
    if (!capability) {
      throw new Error(`GitHub notification capability ${id} is not implemented.`);
    }
    return capability;
  }
}
