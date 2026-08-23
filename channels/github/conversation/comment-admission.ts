import { createHash } from 'node:crypto';

import type { GitHubNotificationsConfiguration } from '../config-schema.ts';
import type { GitHubIdentity } from '../provider/work-item.ts';

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

export interface GitHubCommentMention {
  end: number;
  start: number;
}

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

function exactMentionPattern(login: string, global = false): RegExp {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9@-])(@${escaped})(?![A-Za-z0-9-])`, global ? 'giu' : 'iu');
}

function maskedText(value: string): string {
  let masked = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    masked += character === '\r' || character === '\n' ? character : ' ';
  }
  return masked;
}

function maskRange(value: string, start: number, end: number): string {
  return `${value.slice(0, start)}${maskedText(value.slice(start, end))}${value.slice(end)}`;
}

function maskPattern(value: string, pattern: RegExp): string {
  let masked = value;
  for (const match of value.matchAll(pattern)) {
    if (match.index === undefined || !match[0]) continue;
    masked = maskRange(masked, match.index, match.index + match[0].length);
  }
  return masked;
}

function authorProseMask(body: string): string {
  let prose = maskPattern(body, /<(blockquote|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/giu);
  prose = maskPattern(prose, /<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$/giu);
  prose = maskPattern(prose, /<!--[\s\S]*?-->/gu);
  prose = maskPattern(prose, /<!--[\s\S]*$/gu);
  let fence: string | undefined;
  let lineStart = 0;
  while (lineStart < prose.length) {
    const newline = prose.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? prose.length : newline;
    const contentEnd = lineEnd > lineStart && prose[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    const line = prose.slice(lineStart, contentEnd);
    const trimmed = line.trimStart();
    const fenceMatch = /^(?<fence>`{3,}|~{3,})/u.exec(trimmed)?.groups?.fence;
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[0];
      else if (fenceMatch[0] === fence) fence = undefined;
      prose = maskRange(prose, lineStart, contentEnd);
    } else if (
      fence ||
      /^(?: {0,3}(?:(?:[-+*]|\d+[.)])\s+))* {0,3}>/u.test(line) ||
      /^(?: {4}|\t)/u.test(line)
    ) {
      prose = maskRange(prose, lineStart, contentEnd);
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  prose = maskPattern(prose, /(`+)(?:[^`]|`(?!\1))*\1/gu);
  for (const match of prose.matchAll(/\]\([^\n)]*\)/gu)) {
    if (match.index === undefined || !match[0]) continue;
    prose = maskRange(prose, match.index + 1, match.index + match[0].length);
  }
  prose = maskPattern(prose, /<[^\n>]+>/gu);
  return maskPattern(prose, /(?:https?|ftp):\/\/\S+/giu);
}

function authorMentions(body: string, login: string): GitHubCommentMention[] {
  const prose = authorProseMask(body);
  const mentions: GitHubCommentMention[] = [];
  for (const match of prose.matchAll(exactMentionPattern(login, true))) {
    if (match.index === undefined || !match[2]) continue;
    const start = match.index + (match[1]?.length ?? 0);
    mentions.push({ end: start + match[2].length, start });
  }
  return mentions;
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
  const mentions = authorMentions(input.comment.body, input.account.login);
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
