import connectCodexGitHubAccount from './codex-github-client.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import GitHubIssueCommentClient from '../channels/github/provider/issue-comment-client.ts';
import GitHubReviewClient from '../channels/github/provider/review-client.ts';
import GitHubReviewReplyClient from '../channels/github/provider/review-reply-client.ts';

export default async function connectCodexFeedback(workspace: string, signal: AbortSignal) {
  const connection = await connectCodexGitHubAccount(workspace, signal);
  const api = new GitHubWorkEventApiClient(connection.account);
  const reviews = new GitHubReviewClient(api, 8000);
  const comments = new GitHubIssueCommentClient(api, 8000);
  return {
    ...connection,
    comments: Object.assign(comments, { reviews }),
    replies: new GitHubReviewReplyClient(api, reviews),
  };
}
