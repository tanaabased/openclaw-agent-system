import githubNotificationCommentInstructions from '../messages/instructions/comment.ts';
import githubNotificationIssuePlanInstructions from '../messages/instructions/issue-plan.ts';
import githubNotificationPullRequestPlanInstructions from '../messages/instructions/pull-request-plan.ts';
import type {
  GitHubNotificationMessageRequest,
  GitHubNotificationMessageEvent,
} from '../messages/types.ts';

export type GitHubNotificationCapabilityId = 'none' | 'tool-free';
export type GitHubNotificationContextId =
  'comment' | 'issue-assignment' | 'none' | 'pull-request-assignment';
export type GitHubNotificationPresentationId = 'assignment-card' | 'direct-comment';

export interface GitHubNotificationMessageDefinition {
  capability: GitHubNotificationCapabilityId;
  context: GitHubNotificationContextId;
  instructions?: string;
  presentation: GitHubNotificationPresentationId;
}

const events = new Set<GitHubNotificationMessageEvent>([
  'assignment-received',
  'comment-received',
  'planning-request',
]);

export function parseGitHubNotificationMessageRequest(
  value: unknown,
): GitHubNotificationMessageRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const request = value as Partial<GitHubNotificationMessageRequest>;
  if (
    (request.assignmentKind !== 'issue' && request.assignmentKind !== 'pull-request') ||
    !events.has(request.event as GitHubNotificationMessageEvent) ||
    (request.mode !== 'auto' && request.mode !== 'plan' && request.mode !== 'work') ||
    Object.keys(value).some((key) => !['assignmentKind', 'event', 'mode'].includes(key))
  ) {
    return undefined;
  }
  return request as GitHubNotificationMessageRequest;
}

/** Resolve one trusted semantic notification request to its owned message layers. */
export default function resolveGitHubNotificationMessage(
  request: GitHubNotificationMessageRequest,
): GitHubNotificationMessageDefinition {
  if (request.mode !== 'plan') {
    throw new Error(`GitHub notification ${request.mode} messages are not implemented.`);
  }
  if (request.event === 'assignment-received') {
    return {
      capability: 'none',
      context: 'none',
      presentation: 'assignment-card',
    };
  }
  if (request.event === 'comment-received') {
    return {
      capability: 'tool-free',
      context: 'comment',
      instructions: githubNotificationCommentInstructions(request),
      presentation: 'direct-comment',
    };
  }
  return {
    capability: 'tool-free',
    context: request.assignmentKind === 'issue' ? 'issue-assignment' : 'pull-request-assignment',
    instructions:
      request.assignmentKind === 'issue'
        ? githubNotificationIssuePlanInstructions
        : githubNotificationPullRequestPlanInstructions,
    presentation: 'assignment-card',
  };
}
