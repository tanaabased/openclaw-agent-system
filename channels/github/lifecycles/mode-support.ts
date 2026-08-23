import type {
  GitHubNotificationLifecycle,
  GitHubNotificationLifecycleModeSupport,
} from './types.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';

export class GitHubNotificationLifecycleModeSupportError extends Error {
  override name = 'GitHubNotificationLifecycleModeSupportError';

  constructor(readonly code: string) {
    super('The GitHub notification lifecycle does not support this mode.');
  }
}

/** Resolve one explicitly declared lifecycle-mode pair or fail closed. */
export default function resolveGitHubNotificationLifecycleModeSupport(
  lifecycle: GitHubNotificationLifecycle,
  modeId: GitHubNotificationModeId,
): GitHubNotificationLifecycleModeSupport {
  const support = lifecycle.modeSupport[modeId];
  if (!support) {
    throw new GitHubNotificationLifecycleModeSupportError(
      'github-notification-lifecycle-mode-unsupported',
    );
  }
  return support;
}
