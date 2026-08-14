import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { githubNotificationProposedReplyHeading } from './presentation.ts';
import {
  GitHubNotificationPublicationError,
  githubNotificationPublicationText,
} from './publication.ts';
import githubNotificationQuotedCandidate, {
  githubNotificationMarkdownHeadings,
} from './quoted-candidate.ts';

type GitHubNotificationCommentResponseFormat = 'legacy' | 'markdown';

export class GitHubNotificationCommentResponseError extends Error {
  override name = 'GitHubNotificationCommentResponseError';

  constructor(readonly code: string) {
    super('The GitHub notification comment response did not contain a safe public reply.');
  }
}

function responseText(payload: ReplyPayload): string {
  return payload.text?.trim() ?? '';
}

function assertMarkdownResponse(response: string): void {
  const lines = response.replace(/\r\n?/gu, '\n').split('\n');
  const headings = githubNotificationMarkdownHeadings(lines);
  const expected = [
    '## 💬 Comment answered',
    '## Response',
    githubNotificationProposedReplyHeading,
  ];
  if (
    headings.length !== expected.length ||
    headings[0]?.line !== 0 ||
    headings.map(({ text }) => text).join('\n') !== expected.join('\n')
  ) {
    throw new GitHubNotificationCommentResponseError(
      'github-notification-comment-response-invalid',
    );
  }
  const summary = lines.slice(1, headings[1]!.line).join('\n').trim();
  const privateResponse = lines
    .slice(headings[1]!.line + 1, headings[2]!.line)
    .join('\n')
    .trim();
  if (!summary || summary.includes('\n') || !privateResponse) {
    throw new GitHubNotificationCommentResponseError(
      'github-notification-comment-response-invalid',
    );
  }
  try {
    githubNotificationQuotedCandidate(response, githubNotificationProposedReplyHeading);
  } catch {
    throw new GitHubNotificationCommentResponseError(
      'github-notification-comment-response-invalid',
    );
  }
}

function legacyComplete(response: string): boolean {
  const privateResponse = /^RESPONSE:[ \t]*$\n(?<body>[\s\S]+)$/mu.exec(response)?.groups?.body;
  return /^GITHUB_REPLY:[ \t]*\S.+$/mu.test(response) && Boolean(privateResponse?.trim());
}

function responseFormat(response: string): GitHubNotificationCommentResponseFormat {
  const headingTexts = githubNotificationMarkdownHeadings(
    response.replace(/\r\n?/gu, '\n').split('\n'),
  ).map(({ text }) => text);
  const hasMarkdown = [
    '## 💬 Comment answered',
    '## Response',
    githubNotificationProposedReplyHeading,
  ].some((heading) => headingTexts.includes(heading));
  const hasLegacy = /^GITHUB_REPLY:|^RESPONSE:/mu.test(response);
  if (hasMarkdown && hasLegacy) {
    throw new GitHubNotificationCommentResponseError(
      'github-notification-comment-response-invalid',
    );
  }
  if (hasMarkdown) {
    assertMarkdownResponse(response);
    return 'markdown';
  }
  if (hasLegacy && legacyComplete(response)) return 'legacy';
  throw new GitHubNotificationCommentResponseError('github-notification-comment-response-missing');
}

function completeResponse(payload: ReplyPayload): boolean {
  try {
    responseFormat(responseText(payload));
    return true;
  } catch {
    return false;
  }
}

/** Select one complete private comment response, preferring an ordinary final. */
export function assertGitHubNotificationCommentResponse(
  payloads: readonly ReplyPayload[],
): ReplyPayload {
  const complete = payloads.filter(completeResponse);
  const ordinary = complete.filter(({ isCommentary }) => isCommentary !== true);
  const candidates = ordinary.length > 0 ? ordinary : complete;
  if (candidates.length !== 1 || !candidates[0]) {
    throw new GitHubNotificationCommentResponseError(
      complete.length === 0
        ? 'github-notification-comment-response-missing'
        : 'github-notification-comment-response-invalid',
    );
  }
  return candidates[0];
}

/** Extract only the visibly quoted or legacy-labeled public candidate. */
export default function githubNotificationCommentReply(payload: ReplyPayload): string {
  const response = responseText(payload);
  const format = responseFormat(response);
  if (format === 'markdown') {
    try {
      return githubNotificationPublicationText('github-reply', [
        {
          text: githubNotificationQuotedCandidate(response, githubNotificationProposedReplyHeading),
        },
      ]);
    } catch (error) {
      if (error instanceof GitHubNotificationCommentResponseError) throw error;
      if (error instanceof GitHubNotificationPublicationError) throw error;
      throw new GitHubNotificationCommentResponseError('github-notification-comment-reply-missing');
    }
  }
  const matches = [...response.matchAll(/^GITHUB_REPLY:[ \t]*(.+?)[ \t]*$/gmu)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new GitHubNotificationCommentResponseError('github-notification-comment-reply-missing');
  }
  return githubNotificationPublicationText('github-reply', [{ text: matches[0][1] }]);
}
