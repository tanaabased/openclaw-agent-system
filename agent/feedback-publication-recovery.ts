import feedbackPresentation from './feedback-presentation.ts';
import feedbackResponse from '../channels/github/presentation/feedback-response.ts';
import { githubNotificationAttributedReplyText } from '../channels/github/publication/publication-contract.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import type { ManagedIssue } from './managed-issue.ts';
import type { OpenClawFeedbackProvider } from './openclaw-feedback.ts';
import {
  isReviewFeedback,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import publicResponse from './public-response.ts';
import redactFeedback from './feedback-redaction.ts';

/** old attempted replies are read-only observations, independent of current conversation progress. */
export default async function recoverFeedbackPublication(input: {
  event: FeedbackSourceEvent;
  intake: Pick<ManagedIssue, 'repository' | 'receiving'>;
  provider: Pick<
    OpenClawFeedbackProvider,
    'identity' | 'getRepository' | 'getItem' | 'findOwnIssueComment' | 'replies'
  >;
  save(): Promise<void>;
}) {
  const { event, intake, provider } = input;
  if (!event.publicationAttempted || !event.result?.publicText)
    throw new Error('feedback-publication-unattempted');
  const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
  const owner = intake.repository.owner.login;
  const name = intake.repository.name;
  const repository = await provider.getRepository(owner, name);
  const item = await provider.getItem(owner, name, event.number);
  if (
    provider.identity.nodeId !== intake.receiving.nodeId ||
    repository.nodeId !== intake.repository.nodeId ||
    item.nodeId !== event.nodeId ||
    item.itemType !== event.itemType
  )
    throw new Error('feedback-source-owner-changed');
  const root =
    isReviewFeedback(source) && source.feedback.receipt.kind === 'review-comment'
      ? source.feedback.comments[0]?.replyToId
      : undefined;
  if (isReviewFeedback(source) && source.feedback.receipt.kind === 'review-comment' && !root)
    throw new Error('feedback-review-thread-missing');
  const result = await publicResponse({
    publication: {
      intent: 'github-reply',
      item: {
        lifecycleId: 'issue',
        number: event.number,
        repositoryName: name,
        repositoryOwner: owner,
        repositoryNodeId: repository.nodeId,
      },
      source: { commentDatabaseId: source.databaseId, revisionId: event.revision },
      text: event.result.publicText,
    },
    attempted: true,
    receipt: event.receipt,
    reconcileOnly: true,
    setAttempted() {
      throw new Error('feedback-recovery-write-forbidden');
    },
    setReceipt(receipt) {
      event.receipt = receipt;
      event.phase = 'published';
      delete event.code;
    },
    save: input.save,
    dependencies: {
      redactText: redactFeedback,
      authorize: async () => ({ authorized: true }),
      exclusive: async (_key, run) => run(),
      connect: async () => ({
        commenterLogin: source.author!.login,
        client: {
          createIssueComment: async () => {
            throw new Error('feedback-recovery-write-forbidden');
          },
          findOwnIssueComment: (o, n, number, marker) =>
            root
              ? provider.replies.find(o, n, number, root, marker)
              : provider.findOwnIssueComment(o, n, number, marker),
        },
      }),
    },
  });
  return {
    ...result,
    eventId: event.id,
    presentation: feedbackResponse({
      sourcePresentation: feedbackPresentation(event, owner + '/' + name),
      privateText: event.result.privateText,
      publicReply: {
        author: provider.identity.login,
        text: githubNotificationAttributedReplyText(
          event.result.publicText,
          source.author!.login,
          redactFeedback,
        ),
      },
      publication:
        result.status === 'published'
          ? {
              url: `https://github.com/${owner}/${name}/${event.itemType === 'issue' ? 'issues' : 'pull'}/${event.number}#${root ? 'discussion_r' : 'issuecomment-'}${result.receipt.databaseId}`,
            }
          : { withheld: 'feedback-publication-unconfirmed' },
    }),
  };
}
