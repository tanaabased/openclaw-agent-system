import resolveGitHubNotificationMessage from '../lib/message-registry.ts';
import githubNotificationCommentContext from '../messages/context/comment.ts';
import githubNotificationCommentInput from '../messages/presentation/comment-input.ts';
import type { GitHubCanonicalIssueComment } from './comment-admission.ts';
import type {
  GitHubNotificationCommentRevisionState,
  GitHubNotificationItemState,
} from './monitor-state.ts';

export interface GitHubNotificationCommentPromptInput {
  comment: GitHubCanonicalIssueComment;
  item: Pick<
    GitHubNotificationItemState,
    'delivery' | 'itemType' | 'number' | 'repositoryName' | 'repositoryOwner'
  >;
  revision: Pick<
    GitHubNotificationCommentRevisionState,
    'bodyDigest' | 'commentDatabaseId' | 'commentNodeId' | 'revisionId'
  >;
}

/** Compose direct comment input, hidden instructions, and structured context separately. */
export default function githubNotificationCommentPrompt(
  input: GitHubNotificationCommentPromptInput,
) {
  const request = {
    assignmentKind: input.item.itemType,
    event: 'comment-received' as const,
    mode: input.item.delivery?.mode ?? ('plan' as const),
  };
  const definition = resolveGitHubNotificationMessage(request);
  return {
    body: githubNotificationCommentInput(input.comment),
    instructions: definition.instructions!,
    request,
    untrustedContext: githubNotificationCommentContext(input),
  };
}
