import type { GitHubCanonicalIssueComment } from '../conversation/comment-admission.ts';

export interface GitHubPullRequestReview extends GitHubCanonicalIssueComment {
  commitId: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt?: string;
  url: string;
}

export interface GitHubPullRequestReviewComment extends GitHubCanonicalIssueComment {
  reviewId: number;
  replyToId?: number;
  url: string;
  path: string;
  diffHunk: string;
  diffTruncated: boolean;
  commitId: string;
  originalCommitId: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  side: 'LEFT' | 'RIGHT' | null;
  startSide: 'LEFT' | 'RIGHT' | null;
  position: number | null;
  originalPosition: number | null;
}

export interface GitHubReviewPage<T> {
  values: T[];
  nextPage: number;
}

export interface GitHubPullRequestReviewClient {
  listReviews(
    owner: string,
    name: string,
    number: number,
    page: number,
  ): Promise<GitHubReviewPage<GitHubPullRequestReview>>;
  listComments(
    owner: string,
    name: string,
    number: number,
    page: number,
  ): Promise<GitHubReviewPage<GitHubPullRequestReviewComment>>;
  getReview(
    owner: string,
    name: string,
    number: number,
    id: number,
  ): Promise<GitHubPullRequestReview>;
  getComment(
    owner: string,
    name: string,
    number: number,
    id: number,
  ): Promise<GitHubPullRequestReviewComment>;
  getReviewComments(
    owner: string,
    name: string,
    number: number,
    id: number,
  ): Promise<GitHubPullRequestReviewComment[]>;
}
