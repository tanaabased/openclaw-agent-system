import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { githubNotificationPublicationText } from './publication.ts';
import {
  githubNotificationMarkdownResponse,
  githubNotificationPublicCandidates,
} from './response-presentation.ts';

interface GitHubNotificationParsedCommentResponse {
  publicCandidate: string;
}

export class GitHubNotificationCommentResponseError extends Error {
  override name = 'GitHubNotificationCommentResponseError';

  constructor(readonly code: string) {
    super('The GitHub notification comment response did not contain a safe public reply.');
  }
}

function responseText(payload: ReplyPayload): string {
  return payload.text?.trim() ?? '';
}

function whitespace(lines: string[]): boolean {
  return lines.join('\n').trim() === '';
}

function parseCommentResponse(payload: ReplyPayload): GitHubNotificationParsedCommentResponse {
  const response = responseText(payload);
  const markdown = githubNotificationMarkdownResponse(response);
  const markdownSections = markdown.visibleLines.filter(({ text }) =>
    /^##[ \t]+Response[ \t]*$/u.test(text),
  );
  const legacySections = markdown.visibleLines.filter(({ text }) =>
    /^RESPONSE:[ \t]*$/u.test(text),
  );
  const candidates = githubNotificationPublicCandidates(response, 'GITHUB_REPLY');
  if (markdownSections.length + legacySections.length !== 1 || candidates.length !== 1) {
    throw new GitHubNotificationCommentResponseError(
      'github-notification-comment-response-invalid',
    );
  }

  const section = (markdownSections[0] ?? legacySections[0])!;
  const candidate = candidates[0]!;
  if (markdownSections.length === 1) {
    if (
      candidate.format !== 'markdown' ||
      candidate.line <= section.line ||
      !whitespace(markdown.lines.slice(0, section.line)) ||
      !whitespace(markdown.lines.slice(candidate.line + 1)) ||
      whitespace(markdown.lines.slice(section.line + 1, candidate.line))
    ) {
      throw new GitHubNotificationCommentResponseError(
        'github-notification-comment-response-invalid',
      );
    }
  } else if (
    candidate.format !== 'legacy' ||
    candidate.line >= section.line ||
    !whitespace(markdown.lines.slice(0, candidate.line)) ||
    !whitespace(markdown.lines.slice(candidate.line + 1, section.line)) ||
    whitespace(markdown.lines.slice(section.line + 1))
  ) {
    throw new GitHubNotificationCommentResponseError(
      'github-notification-comment-response-invalid',
    );
  }

  return { publicCandidate: candidate.value };
}

function completeResponse(payload: ReplyPayload): boolean {
  try {
    parseCommentResponse(payload);
    return true;
  } catch {
    return false;
  }
}

/** Select one complete private comment response, preferring an ordinary final. */
export function assertGitHubNotificationCommentResponse(
  payloads: readonly ReplyPayload[],
): ReplyPayload {
  const textPayloads = payloads.filter((payload) => responseText(payload));
  if (textPayloads.length === 0) {
    throw new GitHubNotificationCommentResponseError(
      'github-notification-comment-response-missing',
    );
  }
  const complete = textPayloads.filter(completeResponse);
  const ordinary = complete.filter(({ isCommentary }) => isCommentary !== true);
  const candidates = ordinary.length > 0 ? ordinary : complete;
  if (candidates.length !== 1 || !candidates[0]) {
    throw new GitHubNotificationCommentResponseError(
      'github-notification-comment-response-invalid',
    );
  }
  return candidates[0];
}

/** Extract only the explicitly labeled public candidate from a complete private response. */
export default function githubNotificationCommentReply(payload: ReplyPayload): string {
  let response: GitHubNotificationParsedCommentResponse;
  try {
    response = parseCommentResponse(payload);
  } catch {
    throw new GitHubNotificationCommentResponseError('github-notification-comment-reply-missing');
  }
  return githubNotificationPublicationText('github-reply', [{ text: response.publicCandidate }]);
}
