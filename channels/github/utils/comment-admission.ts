import { createHash } from 'node:crypto';

import type { GitHubNotificationsConfiguration } from '../config-schema.ts';
import type { GitHubIdentity } from './work-item.ts';

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
  | 'comment-approved'
  | 'comment-body-truncated'
  | 'comment-mention-missing'
  | 'comment-mention-quote-only';

export interface GitHubCommentAdmission {
  code: GitHubCommentAdmissionCode;
  disposition: 'approved' | 'rejected';
}

export interface GitHubCommentRevision {
  bodyDigest: string;
  revisionId: string;
}

function exactMentionPattern(login: string): RegExp {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9@-])@${escaped}(?![A-Za-z0-9-])`, 'iu');
}

function authorProse(body: string): string {
  const lines = body
    .replace(/<(blockquote|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$/giu, ' ')
    .split(/\r?\n/u);
  const prose: string[] = [];
  let fence: string | undefined;
  let htmlComment = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(?<fence>`{3,}|~{3,})/u.exec(trimmed)?.groups?.fence;
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[0];
      else if (fenceMatch[0] === fence) fence = undefined;
      continue;
    }
    if (
      fence ||
      /^(?: {0,3}(?:(?:[-+*]|\d+[.)])\s+))* {0,3}>/u.test(line) ||
      /^(?: {4}|\t)/u.test(line)
    ) {
      continue;
    }
    let value = line;
    if (htmlComment) {
      const end = value.indexOf('-->');
      if (end < 0) continue;
      value = value.slice(end + 3);
      htmlComment = false;
    }
    while (value.includes('<!--')) {
      const start = value.indexOf('<!--');
      const end = value.indexOf('-->', start + 4);
      if (end < 0) {
        value = value.slice(0, start);
        htmlComment = true;
        break;
      }
      value = `${value.slice(0, start)} ${value.slice(end + 3)}`;
    }
    prose.push(
      value
        .replace(/(`+)(?:[^`]|`(?!\1))*\1/gu, ' ')
        .replace(/\]\([^\n)]*\)/gu, ']')
        .replace(/<[^\n>]+>/gu, ' ')
        .replace(/(?:https?|ftp):\/\/\S+/giu, ' '),
    );
  }
  return prose.join('\n');
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
  comment: GitHubCanonicalIssueComment;
  configuration: GitHubNotificationsConfiguration;
}): GitHubCommentAdmission {
  const author = input.comment.author;
  if (!author) return { code: 'comment-actor-missing', disposition: 'rejected' };
  if (author.nodeId === input.account.nodeId) {
    return { code: 'comment-actor-self', disposition: 'rejected' };
  }
  if (author.type !== 'User') {
    return { code: 'comment-actor-unsupported', disposition: 'rejected' };
  }
  if (!input.configuration.approvedActors.some(({ nodeId }) => nodeId === author.nodeId)) {
    return { code: 'comment-actor-unapproved', disposition: 'rejected' };
  }
  if (input.comment.bodyTruncated) {
    return { code: 'comment-body-truncated', disposition: 'rejected' };
  }
  const mention = exactMentionPattern(input.account.login);
  if (mention.test(authorProse(input.comment.body))) {
    return { code: 'comment-approved', disposition: 'approved' };
  }
  return {
    code: mention.test(input.comment.body)
      ? 'comment-mention-quote-only'
      : 'comment-mention-missing',
    disposition: 'rejected',
  };
}
