import type { FeedbackSourceEvent } from './feedback-state.ts';
import {
  isReviewFeedback,
  reviewFeedbackPresentation,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import { githubNotificationCommentPresentation } from '../channels/github/presentation/comment.ts';

/** preserve the existing incoming card on both native input and context readback. */
export default function feedbackPresentation(
  event: Pick<FeedbackSourceEvent, 'source' | 'itemType' | 'number'>,
  repository: string,
) {
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

export const feedbackResponseInstructions =
  'The incoming comment or review card is already visible as native input. Do not replay it in your response. Show the returned response presentation once, preserving the exact public reply, attribution links, distinct private context, publication outcome and any actual diagnostic events. Do not repeat the same answer outside its reply card. ';
