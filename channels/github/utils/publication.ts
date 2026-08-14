import { createHash } from 'node:crypto';

import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { redactSensitiveText } from 'openclaw/plugin-sdk/security-runtime';

import { githubNotificationConversationId } from '../channel.ts';
import type { GitHubNotificationItemState } from './monitor-state.ts';

const maximumPublicationLength = 800;
const maximumAcknowledgmentLength = 200;
const markerPrefix = 'agent-system-github-publication';

export type GitHubNotificationPublicationIntent =
  'github-reply' | 'initial-acknowledgment' | 'operator-progress';

const publicationIntents = new Set<GitHubNotificationPublicationIntent>([
  'github-reply',
  'initial-acknowledgment',
  'operator-progress',
]);

export class GitHubNotificationPublicationError extends Error {
  override name = 'GitHubNotificationPublicationError';

  constructor(readonly code: string) {
    super('The GitHub notification message was not safe to publish.');
  }
}

function reject(code: string): never {
  throw new GitHubNotificationPublicationError(code);
}

function intent(value: string): GitHubNotificationPublicationIntent {
  if (publicationIntents.has(value as GitHubNotificationPublicationIntent)) {
    return value as GitHubNotificationPublicationIntent;
  }
  throw new Error('GitHub notification publication intents are invalid.');
}

function safeText(value: string, publicationIntent: GitHubNotificationPublicationIntent): string {
  const text = value.trim();
  const maximumLength =
    publicationIntent === 'initial-acknowledgment'
      ? maximumAcknowledgmentLength
      : maximumPublicationLength;
  if (!text || text.length > maximumLength || /\0/u.test(text)) {
    reject('github-notification-publication-text-invalid');
  }
  if (publicationIntent === 'initial-acknowledgment') {
    if (
      /[\r\n]/u.test(text) ||
      !/\p{L}/u.test(text) ||
      (text.match(/[.!?]+(?=\s|$)/gu)?.length ?? 0) > 1
    ) {
      reject('github-notification-publication-acknowledgment-invalid');
    }
  }
  if (
    redactSensitiveText(text) !== text ||
    /(?:https?|ftp):\/\/|www\.|\bgithub\.com\b|\b[A-Z][A-Z0-9_]{2,}=|@[A-Za-z0-9]/iu.test(text) ||
    /(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]+/u.test(text) ||
    /\b[A-Za-z0-9_=-]{32,}\b/u.test(text) ||
    /(?:^|\s)(?:~?\/|[A-Za-z]:\\|file:)|\/(?:Users|home)\/|\\\\/u.test(text) ||
    ['`', '<', '>', '[', ']', '{', '}', '|'].some((character) => text.includes(character)) ||
    /^\s*(?:[-+*#>]|\d+[.)])/mu.test(text)
  ) {
    reject('github-notification-publication-secret-safety-rejected');
  }
  return text;
}

/** Accept one bounded final agent reply for an explicit GitHub publication intent. */
export function githubNotificationPublicationText(
  publicationIntent: GitHubNotificationPublicationIntent,
  payloads: readonly ReplyPayload[],
): string {
  if (payloads.length !== 1) reject('github-notification-publication-output-count-invalid');
  const payload = payloads[0];
  if (
    !payload ||
    payload.mediaUrl ||
    (payload.mediaUrls?.length ?? 0) > 0 ||
    payload.presentation ||
    payload.interactive ||
    payload.channelData ||
    payload.isError
  ) {
    reject('github-notification-publication-output-shape-invalid');
  }
  return safeText(payload.text ?? '', publicationIntent);
}

export interface GitHubNotificationPublicationTarget {
  conversationId: string;
  digest: string;
  intent: GitHubNotificationPublicationIntent;
}

/** Build an opaque durable target for exactly one canonical GitHub publication. */
export function githubNotificationPublicationTarget(input: {
  intent: GitHubNotificationPublicationIntent;
  item: Pick<GitHubNotificationItemState, 'number' | 'repositoryNodeId'>;
  publicationId: string;
}): string {
  const publicationId = input.publicationId.trim();
  if (!publicationId || publicationId.length > 255 || /[\s\0]/u.test(publicationId)) {
    throw new Error('GitHub notification publication ids are invalid.');
  }
  const digest = createHash('sha256').update(publicationId).digest('hex').slice(0, 32);
  return `${githubNotificationConversationId({
    itemNumber: input.item.number,
    repositoryId: input.item.repositoryNodeId,
  })}:publication:${input.intent}:${digest}`;
}

/** Parse only targets minted by the Agent System publication entry point. */
export function parseGitHubNotificationPublicationTarget(
  value: string,
): GitHubNotificationPublicationTarget {
  const match = /^(github:[^:]+:[1-9]\d*):publication:([a-z-]+):([a-f0-9]{32})$/u.exec(value);
  if (!match) throw new Error('GitHub notification publication targets are invalid.');
  return {
    conversationId: match[1]!,
    intent: intent(match[2]!),
    digest: match[3]!,
  };
}

/** Derive the hidden provider marker carried by a publication target. */
export function githubNotificationPublicationMarker(target: string): string {
  const parsed = parseGitHubNotificationPublicationTarget(target);
  return `<!-- ${markerPrefix}:${parsed.intent}:${parsed.digest} -->`;
}

export function githubNotificationPublicationComment(text: string, marker: string): string {
  if (
    !new RegExp(
      `^<!-- ${markerPrefix}:(?:github-reply|initial-acknowledgment|operator-progress):[a-f0-9]{32} -->$`,
      'u',
    ).test(marker)
  ) {
    throw new Error('GitHub notification publication markers are invalid.');
  }
  return `${text}\n\n${marker}`;
}
