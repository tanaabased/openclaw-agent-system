import GitHubNotificationTurnCatalog, {
  githubNotificationSupportedTurnIdentities,
} from '../channels/github/conversation/turn-catalog.ts';
import GitHubNotificationTurnContractResolver from '../channels/github/conversation/turn-contract.ts';
import githubNotificationAssignmentEvent from '../channels/github/events/assignment.ts';
import githubNotificationCommentEvent from '../channels/github/events/comment.ts';
import githubNotificationImplementationEvent from '../channels/github/events/implementation.ts';
import GitHubNotificationEventRegistry from '../channels/github/events/registry.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubPullRequestLifecycle from '../channels/github/lifecycles/pull-request.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import GitHubNotificationModeRegistry from '../channels/github/modes/registry.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';

export function createGitHubNotificationTurnDefinitions(options?: {
  includePullRequest?: boolean;
}) {
  return {
    events: new GitHubNotificationEventRegistry([
      githubNotificationAssignmentEvent,
      githubNotificationCommentEvent,
      githubNotificationImplementationEvent,
    ]),
    lifecycles: new GitHubNotificationLifecycleRegistry([
      new GitHubIssueLifecycle({
        async inspectGitHub() {
          return undefined;
        },
        async prepareGitHub() {
          throw new Error('not used');
        },
      }),
      ...(options?.includePullRequest ? [new GitHubPullRequestLifecycle()] : []),
    ]),
    modes: new GitHubNotificationModeRegistry([githubNotificationWorkMode]),
  };
}

export function createGitHubNotificationTurnContractResolver() {
  const definitions = createGitHubNotificationTurnDefinitions();
  const turns = new GitHubNotificationTurnCatalog(
    githubNotificationSupportedTurnIdentities,
    definitions,
  );
  return new GitHubNotificationTurnContractResolver({ turns });
}
