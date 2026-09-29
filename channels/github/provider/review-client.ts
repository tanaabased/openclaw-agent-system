import { githubCommentPageSize } from './issue-comment-client.ts';
import {
  githubRepositoryEndpoint,
  GitHubWorkEventClientError,
  type default as GitHubWorkEventApiClient,
} from './work-event-api-client.ts';
import {
  githubResponseRecord,
  githubResponsePositiveInteger,
  githubResponseNodeId,
  githubResponseOptionalIdentity,
  githubResponseTimestamp,
  githubResponseBoundedProse,
  githubResponseGitSha,
  githubResponseString,
} from './work-event-normalization.ts';
import type {
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
  GitHubPullRequestReviewClient,
  GitHubReviewPage,
} from './review-types.ts';

const maximumDiffCharacters = 8_000;
const maximumReviewComments = 400;

function positive(value: unknown): number {
  return githubResponsePositiveInteger(value, 'review identifier');
}

function pullEndpoint(owner: string, name: string, number: number): string {
  return `${githubRepositoryEndpoint(owner, name)}/pulls/${positive(number)}`;
}

function location(value: unknown): number | null {
  return value === null || value === undefined ? null : positive(value);
}

function side(value: unknown): 'LEFT' | 'RIGHT' | null {
  if (value === null || value === undefined) return null;
  if (value !== 'LEFT' && value !== 'RIGHT')
    throw new Error('GitHub returned an invalid review side.');
  return value;
}

/** read bounded review resources without confusing their identifiers with issue comments. */
export default class GitHubReviewClient implements GitHubPullRequestReviewClient {
  constructor(
    readonly api: GitHubWorkEventApiClient,
    readonly maximumCommentCharacters: number,
  ) {}

  #projection(comment: boolean): string {
    const shared = `id,node_id,user:(if .user == null then null else {login:.user.login,nodeId:.user.node_id,type:.user.type} end),body:((.body//"")[0:${this.maximumCommentCharacters + 1}]),bodyLength:(.body//""|length),html_url,pull_request_url,commit_id`;
    return `{${shared},${comment ? `created_at,updated_at,pull_request_review_id,in_reply_to_id,path,diff_hunk:((.diff_hunk//"")[0:${maximumDiffCharacters + 1}]),original_commit_id,line,original_line,start_line,original_start_line,side,start_side,position,original_position` : 'state,submitted_at'}}`;
  }

  #base(raw: unknown, endpoint: string, comment: boolean) {
    const value = githubResponseRecord(raw, 'review resource');
    if (
      typeof value.pull_request_url !== 'string' ||
      value.pull_request_url.toLowerCase() !== `https://api.github.com${endpoint}`.toLowerCase()
    )
      throw new Error('GitHub returned a review resource for another pull request.');
    const databaseId = positive(value.id);
    const url = githubResponseString(value.html_url, 'review url');
    const publicPath = endpoint.replace(/^\/repos\//u, '/').replace(/\/pulls\/(\d+)$/u, '/pull/$1');
    const parsed = new URL(url);
    if (
      parsed.origin !== 'https://github.com' ||
      parsed.pathname.toLowerCase() !== publicPath.toLowerCase() ||
      parsed.search ||
      !(comment
        ? /^#discussion_(?:r[1-9]\d*|diff-[A-Za-z0-9_-]+)$/u.test(parsed.hash) ||
          /^#discussion-diff-[A-Za-z0-9_-]+$/u.test(parsed.hash)
        : parsed.hash === `#pullrequestreview-${databaseId}`)
    )
      throw new Error('GitHub returned an invalid review permalink.');
    const prose = githubResponseBoundedProse(
      value.body,
      'review body',
      this.maximumCommentCharacters,
    );
    const author = githubResponseOptionalIdentity(value.user, 'review author');
    const timestamp = comment
      ? githubResponseTimestamp(value.created_at, 'review comment creation')
      : value.submitted_at == null
        ? '1970-01-01T00:00:00Z'
        : githubResponseTimestamp(value.submitted_at, 'review submission');
    return {
      ...(author ? { author } : {}),
      body: prose.text,
      bodyTruncated: prose.truncated || Number(value.bodyLength) > this.maximumCommentCharacters,
      createdAt: timestamp,
      updatedAt: comment
        ? githubResponseTimestamp(value.updated_at, 'review comment update')
        : timestamp,
      databaseId,
      nodeId: githubResponseNodeId(value.node_id, 'review node id'),
      commitId: githubResponseGitSha(value.commit_id, 'review commit'),
      url,
    };
  }

  #review(raw: unknown, endpoint: string): GitHubPullRequestReview {
    const value = githubResponseRecord(raw, 'review');
    const state = value.state;
    if (
      state !== 'APPROVED' &&
      state !== 'CHANGES_REQUESTED' &&
      state !== 'COMMENTED' &&
      state !== 'DISMISSED' &&
      state !== 'PENDING'
    )
      throw new Error('GitHub returned an invalid review state.');
    return {
      ...this.#base(raw, endpoint, false),
      state,
      ...(value.submitted_at == null
        ? {}
        : { submittedAt: githubResponseTimestamp(value.submitted_at, 'review submission') }),
    };
  }

  #comment(raw: unknown, endpoint: string): GitHubPullRequestReviewComment {
    const value = githubResponseRecord(raw, 'review comment');
    const diff = githubResponseBoundedProse(value.diff_hunk, 'review diff', maximumDiffCharacters);
    const path = githubResponseString(value.path, 'review path');
    if (path.length > 4096 || /[\0\r\n]/u.test(path))
      throw new Error('GitHub returned an invalid review path.');
    return {
      ...this.#base(raw, endpoint, true),
      reviewId: positive(value.pull_request_review_id),
      ...(value.in_reply_to_id == null ? {} : { replyToId: positive(value.in_reply_to_id) }),
      path,
      diffHunk: diff.text,
      diffTruncated: diff.truncated,
      originalCommitId: githubResponseGitSha(value.original_commit_id, 'original review commit'),
      line: location(value.line),
      originalLine: location(value.original_line),
      startLine: location(value.start_line),
      originalStartLine: location(value.original_start_line),
      side: side(value.side),
      startSide: side(value.start_side),
      position: location(value.position),
      originalPosition: location(value.original_position),
    };
  }

  async #page(
    owner: string,
    name: string,
    number: number,
    page: number,
    suffix: string,
    comment: boolean,
  ) {
    positive(page);
    const endpoint = pullEndpoint(owner, name, number);
    const size = Math.min(
      10,
      githubCommentPageSize(this.maximumCommentCharacters + maximumDiffCharacters),
    );
    const response = await this.api.request(
      [
        '--method',
        'GET',
        `${endpoint}/${suffix}`,
        '-F',
        `per_page=${size}`,
        '-F',
        `page=${page}`,
        '--jq',
        `[.[]|${this.#projection(comment)}]`,
      ],
      'pull request feedback',
    );
    if (!Array.isArray(response.value)) throw new Error('GitHub returned invalid review pages.');
    return { raw: response.value, endpoint, nextPage: response.hasNextPage ? page + 1 : 1 };
  }

  async listReviews(
    owner: string,
    name: string,
    number: number,
    page: number,
  ): Promise<GitHubReviewPage<GitHubPullRequestReview>> {
    const result = await this.#page(owner, name, number, page, 'reviews', false);
    return {
      values: result.raw.map((value) => this.#review(value, result.endpoint)),
      nextPage: result.nextPage,
    };
  }

  async listComments(
    owner: string,
    name: string,
    number: number,
    page: number,
  ): Promise<GitHubReviewPage<GitHubPullRequestReviewComment>> {
    const result = await this.#page(owner, name, number, page, 'comments', true);
    return {
      values: result.raw.map((value) => this.#comment(value, result.endpoint)),
      nextPage: result.nextPage,
    };
  }

  async getReview(
    owner: string,
    name: string,
    number: number,
    id: number,
  ): Promise<GitHubPullRequestReview> {
    const endpoint = pullEndpoint(owner, name, number);
    const response = await this.api.request(
      ['--method', 'GET', `${endpoint}/reviews/${positive(id)}`, '--jq', this.#projection(false)],
      'pull request review',
    );
    const review = this.#review(response.value, endpoint);
    if (review.databaseId !== id) throw new Error('GitHub returned another review.');
    return review;
  }

  async getComment(
    owner: string,
    name: string,
    number: number,
    id: number,
  ): Promise<GitHubPullRequestReviewComment> {
    const endpoint = pullEndpoint(owner, name, number);
    const response = await this.api.request(
      [
        '--method',
        'GET',
        `${githubRepositoryEndpoint(owner, name)}/pulls/comments/${positive(id)}`,
        '--jq',
        this.#projection(true),
      ],
      'pull request review comment',
    );
    const comment = this.#comment(response.value, endpoint);
    if (comment.databaseId !== id) throw new Error('GitHub returned another review comment.');
    return comment;
  }

  async getReviewComments(
    owner: string,
    name: string,
    number: number,
    id: number,
  ): Promise<GitHubPullRequestReviewComment[]> {
    const comments = new Map<string, GitHubPullRequestReviewComment>();
    for (let page = 1; page <= 40; page++) {
      const result = await this.#page(
        owner,
        name,
        number,
        page,
        `reviews/${positive(id)}/comments`,
        true,
      );
      for (const raw of result.raw) {
        const comment = this.#comment(raw, result.endpoint);
        if (comment.reviewId !== id)
          throw new Error('GitHub returned a comment for another review.');
        comments.set(comment.nodeId, comment);
      }
      if (comments.size > maximumReviewComments) break;
      if (result.nextPage === 1) return [...comments.values()];
    }
    throw new GitHubWorkEventClientError(
      'github-notification-review-truncated',
      'The complete review exceeds its intake boundary.',
    );
  }
}
