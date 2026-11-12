import ReplyStore, { type ReplyBinding } from './reply-store.ts';
import type { ReplyTarget } from './reply-target.ts';
import redactFeedback from './feedback-redaction.ts';
import GitHubNotificationCommentPublisher from '../../../channels/github/publication/comment-publisher.ts';
import type { GitHubNotificationPublicationClient } from '../../../channels/github/provider/work-event-client.ts';
import type GitHubReviewReplyClient from '../../../channels/github/provider/review-reply-client.ts';

/** Observe existing reply effects only; intake never sends or resumes conversational work. */
export default async function replyOwnPublications(input: {
  root: string;
  binding: ReplyBinding;
  client: GitHubNotificationPublicationClient;
  replies?: Pick<GitHubReviewReplyClient, 'find' | 'create'>;
}) {
  const ids: string[] = [];
  for (const draft of await new ReplyStore(input.root, input.binding).read()) {
    if (draft.authorNodeId !== input.client.identity.nodeId) continue;
    if (draft.receipt) {
      ids.push(draft.receipt.nodeId);
      continue;
    }
    if (!draft.attempted || !draft.publication) continue;
    const target = JSON.parse(draft.target) as ReplyTarget;
    if (target.root && !input.replies) throw new Error('feedback-review-client-missing');
    const publisher = new GitHubNotificationCommentPublisher({
      authorize: async () => ({ authorized: true }),
      exclusive: async (_key, run) => run(),
      redactText: redactFeedback,
      connect: async () => ({
        commenterLogin: target.source?.author?.login,
        client: target.root
          ? {
              createIssueComment: () => {
                throw new Error('reply-observation-only');
              },
              findOwnIssueComment: (owner, name, number, marker) =>
                input.replies!.find(owner, name, number, target.root!, marker),
            }
          : input.client,
      }),
    });
    const observed = await publisher.reconcile(JSON.parse(draft.publication));
    if (observed) ids.push(observed.receipt.nodeId);
  }
  return ids;
}
