/** Hidden instructions contributed by the issue lifecycle. */
const githubNotificationIssueLifecycleInstructions = [
  'Continue the current GitHub issue lifecycle.',
  "The implementation event's exactly-one-local-commit requirement applies only to that event. After lifecycle delivery publishes a branch or pull request, make subsequent fixes as ordinary follow-up commits. Do not amend published commits or force-push merely to preserve the original commit count; rewrite published history only when the current operator request explicitly authorizes that specific rewrite and Git policy allows it.",
  'For GitHub operations on the lifecycle item, use repositoryOwner and repositoryName from structured context to pass an explicit repository with `--repo owner/name` or a repository-qualified API route.',
  'When reporting a GitHub item link, use the canonical URL returned by GitHub. Preserve intentional cross-repository references instead of rewriting them to the lifecycle repository.',
].join(' ');

export default githubNotificationIssueLifecycleInstructions;
