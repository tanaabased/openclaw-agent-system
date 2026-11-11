import safePresentation from '../channels/github/presentation/safe.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import {
  isReviewFeedback,
  reviewFeedbackPresentation,
  reviewFeedbackContext,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import { githubNotificationCommentPresentation } from '../channels/github/presentation/comment.ts';

/** preserve the existing incoming card on both native input and context readback. */
export default function feedbackPresentation(
  event: Pick<FeedbackSourceEvent, 'source' | 'itemType' | 'number'>,
  repository: string,
) {
  const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
  const url = `https://github.com/${repository}/${event.itemType === 'issue' ? 'issues' : 'pull'}/${event.number}#issuecomment-${source.databaseId}`;
  const review = isReviewFeedback(source) ? reviewFeedbackContext(source) : undefined;
  return safePresentation(
    () =>
      isReviewFeedback(source)
        ? reviewFeedbackPresentation(source)
        : githubNotificationCommentPresentation({
            author: {
              label: source.author!.login,
              url: `https://github.com/${source.author!.login}`,
            },
            body: source.body,
            item: {
              label: `${repository}#${event.number}`,
              url: `https://github.com/${repository}/${event.itemType === 'issue' ? 'issues' : 'pull'}/${event.number}#issuecomment-${source.databaseId}`,
            },
          }),
    () =>
      [
        source.body,
        ...(review?.findings.map((finding) => `${finding.body}\n${finding.url}\n${finding.path}`) ??
          []),
        `Source: ${isReviewFeedback(source) ? source.feedback.review.url : url}`,
        `Author: ${source.author!.login}`,
      ].join('\n\n'),
  );
}

export const feedbackResponseInstructions =
  'Keep the incoming comment or review visible in its native input card; do not replay it in your response. Always show the exact outgoing reply in its attributed card, including its publication link or draft status. Keep publication obstacles and actual diagnostic events. Outside the cards, use normal concise prose only for additional findings, limitations or actions not already conveyed by the assessment, questions or reply. Omit redundant private paraphrases and section labels; never shorten or omit a comment or reply card to reduce repetition. ';
