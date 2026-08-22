export type GitHubNotificationExecutionSurface = 'cli-one-shot' | 'gateway';

/** Select the host-owned teardown contract for one notification model turn. */
export function githubNotificationReplyCleanupOptions(
  surface: GitHubNotificationExecutionSurface,
): {
  cleanupBundleMcpOnRunEnd?: true;
  cleanupCliLiveSessionOnRunEnd?: true;
  oneShotCliRun?: true;
} {
  return surface === 'cli-one-shot'
    ? {
        cleanupBundleMcpOnRunEnd: true,
        cleanupCliLiveSessionOnRunEnd: true,
        oneShotCliRun: true,
      }
    : {};
}
