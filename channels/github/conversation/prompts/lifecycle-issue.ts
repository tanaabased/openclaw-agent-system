/** Hidden instructions contributed by the issue lifecycle. */
const githubNotificationIssueLifecycleInstructions = [
  'Continue the current GitHub issue lifecycle.',
  'For GitHub operations on the lifecycle item, use repositoryOwner and repositoryName from structured context to pass an explicit repository with `--repo owner/name` or a repository-qualified API route.',
  'When reporting a GitHub item link, use the canonical URL returned by GitHub. Preserve intentional cross-repository references instead of rewriting them to the lifecycle repository.',
].join(' ');

export default githubNotificationIssueLifecycleInstructions;
