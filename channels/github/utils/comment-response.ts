import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { githubNotificationPublicationText } from './publication.ts';

export class GitHubNotificationCommentResponseError extends Error {
  override name = 'GitHubNotificationCommentResponseError';

  constructor(readonly code: string) {
    super('The GitHub notification comment response did not contain a safe public reply.');
  }
}

function responseText(payload: ReplyPayload): string {
  return payload.text?.trim() ?? '';
}

function completeResponse(payload: ReplyPayload): boolean {
  const text = responseText(payload);
  return /^GITHUB_REPLY:[ \t]*\S.+$/mu.test(text) && /^RESPONSE:[ \t]*$/mu.test(text);
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
  const candidate = candidates[0]!;
  const response = responseText(candidate);
  const section = /^RESPONSE:[ \t]*$\n(?<body>[\s\S]+)$/mu.exec(response)?.groups?.body?.trim();
  if (!section) {
    throw new GitHubNotificationCommentResponseError(
      'github-notification-comment-response-invalid',
    );
  }
  return candidate;
}

/** Extract only the explicitly labeled public candidate from a private comment response. */
export default function githubNotificationCommentReply(payload: ReplyPayload): string {
  const matches = [...responseText(payload).matchAll(/^GITHUB_REPLY:[ \t]*(.+?)[ \t]*$/gmu)];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new GitHubNotificationCommentResponseError('github-notification-comment-reply-missing');
  }
  return githubNotificationPublicationText('github-reply', [{ text: matches[0][1] }]);
}
