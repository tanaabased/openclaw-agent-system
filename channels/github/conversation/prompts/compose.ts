import githubNotificationCommentEventInstructions from './event-comment.ts';
import githubNotificationIssueLifecycleInstructions from './lifecycle-issue.ts';
import githubNotificationWorkModeInstructions from './mode-work.ts';
import githubNotificationResponseInstructions from './response.ts';

/** Compose hidden instructions for the currently supported issue comment turn. */
const githubNotificationIssueWorkCommentInstructions = [
  `${githubNotificationIssueLifecycleInstructions} in Work mode. ${githubNotificationCommentEventInstructions}`,
  githubNotificationWorkModeInstructions,
  githubNotificationResponseInstructions,
].join('\n\n');

export default githubNotificationIssueWorkCommentInstructions;
