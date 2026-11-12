import type GitHubReviewReplyClient from '../../../channels/github/provider/review-reply-client.ts';
import type { GitHubNotificationProviderClient } from '../../../channels/github/provider/work-event-types.ts';

export type FeedbackProvider = GitHubNotificationProviderClient & {
  replies: Pick<GitHubReviewReplyClient, 'find' | 'create'>;
};
