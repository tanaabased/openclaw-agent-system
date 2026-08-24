import { createHash } from 'node:crypto';

import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { redactSensitiveText } from 'openclaw/plugin-sdk/security-runtime';

import { githubNotificationConversationId } from '../channel.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import { maximumGitHubNotificationReplyLength } from './limits.ts';

const maximumAcknowledgmentLength = 200;
const markerPrefix = 'agent-system-github-publication';
export const githubNotificationCommenterToken = '{{commenter}}';

export type GitHubNotificationPublicationIntent =
  'assignment-response' | 'github-reply' | 'initial-acknowledgment';

export type GitHubNotificationPublicationSafetyCategory =
  'credential-prefix' | 'environment-assignment' | 'mention' | 'redaction';

const publicationIntents = new Set<GitHubNotificationPublicationIntent>([
  'assignment-response',
  'github-reply',
  'initial-acknowledgment',
]);

export class GitHubNotificationPublicationError extends Error {
  override name = 'GitHubNotificationPublicationError';

  constructor(
    readonly code: string,
    readonly safetyCategory?: GitHubNotificationPublicationSafetyCategory,
  ) {
    super('The GitHub notification message was not safe to publish.');
  }
}

function reject(code: string, safetyCategory?: GitHubNotificationPublicationSafetyCategory): never {
  throw new GitHubNotificationPublicationError(code, safetyCategory);
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
      : maximumGitHubNotificationReplyLength;
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
  const commenterTokenIndex = text.indexOf(githubNotificationCommenterToken);
  const commenterTokenEnd = commenterTokenIndex + githubNotificationCommenterToken.length;
  if (
    commenterTokenIndex >= 0 &&
    (publicationIntent !== 'github-reply' ||
      text.indexOf(githubNotificationCommenterToken, commenterTokenEnd) >= 0 ||
      (commenterTokenIndex > 0 && !/[\s({"',.:;!?—-]$/u.test(text.slice(0, commenterTokenIndex))) ||
      (commenterTokenEnd < text.length &&
        !/^[\s)}"',.:;!?—]/u.test(text.slice(commenterTokenEnd))) ||
      !/\p{L}/u.test(`${text.slice(0, commenterTokenIndex)}${text.slice(commenterTokenEnd)}`))
  ) {
    reject('github-notification-publication-commenter-token-invalid');
  }
  const secretSafetyCode = 'github-notification-publication-secret-safety-rejected';
  if (/\b[A-Z][A-Z0-9_]{2,}=/u.test(text)) {
    reject(secretSafetyCode, 'environment-assignment');
  }
  if (/@[A-Za-z0-9]/iu.test(text)) reject(secretSafetyCode, 'mention');
  if (/(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]+/u.test(text)) {
    reject(secretSafetyCode, 'credential-prefix');
  }
  if (redactSensitiveText(text) !== text) reject(secretSafetyCode, 'redaction');
  return text;
}

/** Substitute only one provider-verified commenter into a safe reply candidate. */
export function githubNotificationAttributedReplyText(
  value: string,
  commenterLogin: string,
): string {
  const text = safeText(value, 'github-reply');
  if (
    commenterLogin.length > 255 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(commenterLogin)
  ) {
    throw new Error('GitHub notification commenter logins are invalid.');
  }
  return text.includes(githubNotificationCommenterToken)
    ? text.replace(githubNotificationCommenterToken, `@${commenterLogin}`)
    : `@${commenterLogin}\n\n${text}`;
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

export interface GitHubNotificationPublicationSource {
  commentDatabaseId: number;
  revisionId: string;
}

type GitHubNotificationPublicationTargetInput = {
  item: Pick<GitHubNotificationItemState, 'lifecycleId' | 'number' | 'repositoryNodeId'>;
} & (
  | {
      intent: 'github-reply';
      source: GitHubNotificationPublicationSource;
    }
  | {
      intent: 'assignment-response' | 'initial-acknowledgment';
      publicationId: string;
    }
);

/** Build an opaque durable target for exactly one canonical GitHub publication. */
export function githubNotificationPublicationTarget(
  input: GitHubNotificationPublicationTargetInput,
): string {
  let identity: string;
  if (input.intent === 'github-reply') {
    if (
      !Number.isSafeInteger(input.source.commentDatabaseId) ||
      input.source.commentDatabaseId < 1 ||
      !/^[a-f0-9]{64}$/u.test(input.source.revisionId)
    ) {
      throw new Error('GitHub notification publication sources are invalid.');
    }
    identity = `${input.source.commentDatabaseId}\0${input.source.revisionId}`;
  } else {
    identity = input.publicationId.trim();
    if (!identity || identity.length > 255 || /[\s\0]/u.test(identity)) {
      throw new Error('GitHub notification publication ids are invalid.');
    }
  }
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  return `${githubNotificationConversationId({
    itemNumber: input.item.number,
    lifecycleId: input.item.lifecycleId,
    repositoryId: input.item.repositoryNodeId,
  })}:publication:${input.intent}:${digest}`;
}

/** Parse only targets minted by the Agent System publication entry point. */
export function parseGitHubNotificationPublicationTarget(
  value: string,
): GitHubNotificationPublicationTarget {
  const match =
    /^(github:(?:issue|pull-request|pull-request-review):[^:]+:[1-9]\d*):publication:([a-z-]+):([a-f0-9]{32})$/u.exec(
      value,
    );
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

/** Add one validated hidden idempotency marker to a public GitHub comment. */
export function githubNotificationPublicationComment(text: string, marker: string): string {
  if (
    !new RegExp(
      `^<!-- ${markerPrefix}:(?:assignment-response|github-reply|initial-acknowledgment):[a-f0-9]{32} -->$`,
      'u',
    ).test(marker)
  ) {
    throw new Error('GitHub notification publication markers are invalid.');
  }
  return `${text}\n\n${marker}`;
}
