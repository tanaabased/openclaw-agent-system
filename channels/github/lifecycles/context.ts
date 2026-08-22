import type {
  GitHubNotificationLifecycleContextInput,
  GitHubNotificationLifecycleId,
} from './types.ts';

/** Project lifecycle-neutral item identity without provider prose. */
export default function githubNotificationItemContext(
  input: GitHubNotificationLifecycleContextInput,
  lifecycleId: GitHubNotificationLifecycleId,
) {
  if (input.item.lifecycleId !== lifecycleId) {
    throw new Error(`The ${lifecycleId} lifecycle received another lifecycle's item.`);
  }
  return {
    lifecycleId: input.item.lifecycleId,
    number: input.item.number,
    repositoryName: input.item.repositoryName,
    repositoryOwner: input.item.repositoryOwner,
  };
}
