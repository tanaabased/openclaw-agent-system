import { createHash } from 'node:crypto';

import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { redactSensitiveText } from 'openclaw/plugin-sdk/security-runtime';

const maximumAcknowledgmentLength = 200;
const markerPrefix = 'agent-system-github-assignment-ack';

export const githubAssignmentAcknowledgmentPrompt =
  'Write one short, natural sentence acknowledging that you accepted a GitHub assignment. ' +
  'Use your own voice and personality. Do not mention issue details, tools, policies, paths, ' +
  'credentials, links, or anything you were not given. Return only the acknowledgment.';

export class GitHubAssignmentAcknowledgmentError extends Error {
  override name = 'GitHubAssignmentAcknowledgmentError';

  constructor(readonly code: string) {
    super('The generated GitHub assignment acknowledgment was not safe to publish.');
  }
}

function reject(code: string): never {
  throw new GitHubAssignmentAcknowledgmentError(code);
}

/** Accept one tightly bounded final agent reply for GitHub publication. */
export function githubAssignmentAcknowledgment(payloads: readonly ReplyPayload[]): string {
  if (payloads.length !== 1) reject('github-notification-acknowledgment-output-count-invalid');
  const payload = payloads[0];
  if (
    !payload ||
    payload.mediaUrl ||
    (payload.mediaUrls?.length ?? 0) > 0 ||
    payload.presentation ||
    payload.interactive ||
    payload.isError
  ) {
    reject('github-notification-acknowledgment-output-shape-invalid');
  }
  const text = payload.text?.trim() ?? '';
  if (!text || text.length > maximumAcknowledgmentLength || /[\r\n\0]/u.test(text)) {
    reject('github-notification-acknowledgment-text-invalid');
  }
  if (!/\p{L}/u.test(text) || (text.match(/[.!?]+(?=\s|$)/gu)?.length ?? 0) > 1) {
    reject('github-notification-acknowledgment-sentence-invalid');
  }
  if (
    redactSensitiveText(text) !== text ||
    /(?:https?|ftp):\/\/|www\.|\bgithub\.com\b|\b[A-Z][A-Z0-9_]{2,}=|@[A-Za-z0-9]/iu.test(text) ||
    /(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]+/u.test(text) ||
    /\b[A-Za-z0-9_=-]{32,}\b/u.test(text) ||
    /(?:^|\s)(?:~?\/|[A-Za-z]:\\|file:)|\/(?:Users|home)\/|\\\\/u.test(text) ||
    ['`', '<', '>', '[', ']', '{', '}', '|'].some((character) => text.includes(character)) ||
    /^\s*(?:[-+*#>]|\d+[.)])/u.test(text)
  ) {
    reject('github-notification-acknowledgment-secret-safety-rejected');
  }
  return text;
}

/** Derive an opaque marker for exactly-once comment reconciliation. */
export function githubAssignmentAcknowledgmentMarker(assignmentEventId: string): string {
  const normalized = assignmentEventId.trim();
  if (!normalized || normalized.length > 255 || /[\s\0]/u.test(normalized)) {
    throw new Error('GitHub assignment event ids are invalid.');
  }
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  return `<!-- ${markerPrefix}:${digest} -->`;
}

export function githubAssignmentAcknowledgmentComment(text: string, marker: string): string {
  if (!marker.startsWith(`<!-- ${markerPrefix}:`) || !marker.endsWith(' -->')) {
    throw new Error('GitHub assignment acknowledgment markers are invalid.');
  }
  return `${text}\n\n${marker}`;
}
