import type { FeedbackSourceEvent } from './feedback-state.ts';
import {
  isReviewFeedback,
  reviewFeedbackPresentation,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import { githubNotificationCommentPresentation } from '../channels/github/presentation/comment.ts';

/** preserve the existing incoming card on both native input and context readback. */
export default function feedbackPresentation(event: FeedbackSourceEvent, repository: string) {
  const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
  return isReviewFeedback(source)
    ? reviewFeedbackPresentation(source)
    : githubNotificationCommentPresentation({
        author: { label: source.author!.login, url: `https://github.com/${source.author!.login}` },
        body: source.body,
        item: {
          label: `${repository}#${event.number}`,
          url: `https://github.com/${repository}/${event.itemType === 'issue' ? 'issues' : 'pull'}/${event.number}#issuecomment-${source.databaseId}`,
        },
      });
}
