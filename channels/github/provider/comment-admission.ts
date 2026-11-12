import { createHash } from 'node:crypto';

import { githubCommentProseMentions, type GitHubCommentMention } from '../comment-mentions.ts';
import type { GitHubIdentityPin } from '../workflow-policy.ts';
import { defaultMaximumCommentCharacters } from './comment-limit.ts';
import type { GitHubIdentity } from './work-item.ts';

export type { GitHubCommentMention } from '../comment-mentions.ts';

export interface GitHubCanonicalIssueComment {
  author?: GitHubIdentity;
  body: string;
  bodyTruncated: boolean;
  createdAt: string;
  databaseId: number;
  nodeId: string;
  updatedAt: string;
}

export type GitHubCommentAdmissionCode =
  | 'comment-actor-missing'
  | 'comment-actor-self'
  | 'comment-actor-unapproved'
  | 'comment-actor-unsupported'
  | 'comment-review-pending'
  | 'comment-approved'
  | 'comment-body-truncated'
  | 'comment-mention-missing'
  | 'comment-mention-quote-only';

export type GitHubCommentAdmission =
  | {
      code: 'comment-approved';
      disposition: 'approved';
      mentions: GitHubCommentMention[];
    }
  | {
      code: Exclude<GitHubCommentAdmissionCode, 'comment-approved'>;
      disposition: 'rejected';
    };

export interface GitHubCommentRevision {
  bodyDigest: string;
  revisionId: string;
}

export interface GitHubCommentAdmissionPolicy {
  approvedFeedbackAuthors?: GitHubIdentityPin[];
}

function exactMentionPattern(login: string): RegExp {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9@-])(@${escaped})(?![A-Za-z0-9-])`, 'iu');
}

/** Derive a value-free identity for one exact current comment revision. */
export function githubCommentRevision(comment: GitHubCanonicalIssueComment): GitHubCommentRevision {
  const bodyDigest = createHash('sha256').update(comment.body).digest('hex');
  const revisionId = createHash('sha256')
    .update(
      [
        comment.nodeId,
        comment.updatedAt,
        bodyDigest,
        comment.bodyTruncated ? 'truncated' : 'complete',
      ].join('\0'),
    )
    .digest('hex');
  return { bodyDigest, revisionId };
}

/** Admit only an approved human's exact mention in current author-written prose. */
export function admitGitHubComment(input: {
  account: GitHubIdentity;
  allowSelf?: boolean;
  comment: GitHubCanonicalIssueComment;
  configuration: GitHubCommentAdmissionPolicy;
  maximumCommentCharacters?: number;
}): GitHubCommentAdmission {
  const author = input.comment.author;
  if (!author) return { code: 'comment-actor-missing', disposition: 'rejected' };
  if (author.nodeId === input.account.nodeId && !input.allowSelf) {
    return { code: 'comment-actor-self', disposition: 'rejected' };
  }
  if (author.type !== 'User') {
    return { code: 'comment-actor-unsupported', disposition: 'rejected' };
  }
  const authors = input.configuration.approvedFeedbackAuthors ?? [];
  if (!authors.some(({ nodeId }) => nodeId === author.nodeId)) {
    return { code: 'comment-actor-unapproved', disposition: 'rejected' };
  }
  const maximumCommentCharacters =
    input.maximumCommentCharacters ?? defaultMaximumCommentCharacters;
  if (input.comment.bodyTruncated || [...input.comment.body].length > maximumCommentCharacters) {
    return { code: 'comment-body-truncated', disposition: 'rejected' };
  }
  const mentions = githubCommentProseMentions(input.comment.body, input.account.login);
  if (mentions.length > 0) {
    return { code: 'comment-approved', disposition: 'approved', mentions };
  }
  return {
    code: exactMentionPattern(input.account.login).test(input.comment.body)
      ? 'comment-mention-quote-only'
      : 'comment-mention-missing',
    disposition: 'rejected',
  };
}
