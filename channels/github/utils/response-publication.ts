import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { githubNotificationToGitHubHeading } from '../messages/presentation/response-envelope.ts';
import {
  githubNotificationPublicationText,
  type GitHubNotificationPublicationIntent,
} from './publication.ts';
import githubNotificationQuotedCandidate, {
  githubNotificationMarkdownHeadings,
} from './quoted-candidate.ts';

export class GitHubNotificationResponsePublicationError extends Error {
  override name = 'GitHubNotificationResponsePublicationError';

  constructor(readonly code: string) {
    super('The GitHub notification response did not contain one complete public candidate.');
  }
}

function responseText(payload: ReplyPayload): string {
  return payload.text?.trim() ?? '';
}

function completeResponse(payload: ReplyPayload): boolean {
  const response = responseText(payload);
  if (!response) return false;
  const lines = response.replace(/\r\n?/gu, '\n').split('\n');
  const headings = githubNotificationMarkdownHeadings(lines);
  const publicHeadings = headings.filter(({ text }) => text === githubNotificationToGitHubHeading);
  if (publicHeadings.length !== 1 || !publicHeadings[0]) return false;
  const privateResponse = lines.slice(0, publicHeadings[0].line).join('\n').trim();
  if (!privateResponse) return false;
  try {
    githubNotificationQuotedCandidate(response, githubNotificationToGitHubHeading);
    return true;
  } catch {
    return false;
  }
}

/** Select one complete private/public response, preferring an ordinary final. */
export function assertGitHubNotificationResponse(payloads: readonly ReplyPayload[]): ReplyPayload {
  const ordinary = payloads.filter(({ isCommentary }) => isCommentary !== true);
  const complete = payloads.filter(completeResponse);
  const candidates = ordinary.length > 0 ? ordinary.filter(completeResponse) : complete;
  if (candidates.length !== 1 || !candidates[0]) {
    throw new GitHubNotificationResponsePublicationError(
      candidates.length === 0
        ? 'github-notification-response-publication-missing'
        : 'github-notification-response-publication-invalid',
    );
  }
  return candidates[0];
}

/** Extract and validate only the quoted `To GitHub` candidate. */
export function githubNotificationResponsePublication(
  payload: ReplyPayload,
  intent: GitHubNotificationPublicationIntent,
): string {
  if (!completeResponse(payload)) {
    throw new GitHubNotificationResponsePublicationError(
      'github-notification-response-publication-invalid',
    );
  }
  return githubNotificationPublicationText(intent, [
    {
      text: githubNotificationQuotedCandidate(
        responseText(payload),
        githubNotificationToGitHubHeading,
      ),
    },
  ]);
}
