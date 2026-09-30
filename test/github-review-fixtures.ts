import type {
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
  GitHubPullRequestReviewClient,
} from '../channels/github/provider/review-types.ts';
import { notificationActor } from './github-notification-fixtures.ts';

export function reviewFixture(
  overrides: Partial<GitHubPullRequestReview> = {},
): GitHubPullRequestReview {
  return {
    author: notificationActor,
    body: '@tanaabot please address these findings',
    bodyTruncated: false,
    databaseId: 81,
    nodeId: 'PRR_review',
    createdAt: '2026-09-01T12:00:00Z',
    updatedAt: '2026-09-01T12:00:00Z',
    submittedAt: '2026-09-01T12:00:00Z',
    commitId: 'a'.repeat(40),
    state: 'COMMENTED',
    url: 'https://github.com/tanaabased/example/pull/45#pullrequestreview-81',
    ...overrides,
  };
}

export function reviewCommentFixture(
  overrides: Partial<GitHubPullRequestReviewComment> = {},
): GitHubPullRequestReviewComment {
  return {
    ...reviewFixture(),
    databaseId: 82,
    nodeId: 'PRRC_finding',
    reviewId: 81,
    body: 'Handle the empty list.',
    url: 'https://github.com/tanaabased/example/pull/45#discussion_r82',
    path: 'api/example.ts',
    diffHunk: '@@ -1 +1 @@\n+return values[0]',
    diffTruncated: false,
    originalCommitId: 'a'.repeat(40),
    line: null,
    originalLine: 1,
    startLine: null,
    originalStartLine: null,
    side: 'RIGHT',
    startSide: null,
    position: null,
    originalPosition: 1,
    ...overrides,
  };
}

export function reviewClientFixture(
  review: GitHubPullRequestReview,
  comments: GitHubPullRequestReviewComment[],
): GitHubPullRequestReviewClient {
  return {
    async listReviews() {
      return { values: [structuredClone(review)], nextPage: 1 };
    },
    async listComments() {
      return { values: structuredClone(comments), nextPage: 1 };
    },
    async getReview() {
      return structuredClone(review);
    },
    async getComment(_owner, _name, _number, id) {
      const comment = comments.find((value) => value.databaseId === id);
      if (!comment) throw new Error('missing review comment fixture');
      return structuredClone(comment);
    },
    async getReviewComments() {
      return structuredClone(comments);
    },
  };
}
