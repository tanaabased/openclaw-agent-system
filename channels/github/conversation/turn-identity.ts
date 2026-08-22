import {
  isGitHubNotificationLifecycleId,
  type GitHubNotificationLifecycleId,
} from '../lifecycles/types.ts';
import { isGitHubNotificationModeId, type GitHubNotificationModeId } from '../modes/types.ts';

export const githubNotificationTurnContextKey = 'githubNotificationTurn';
export const githubNotificationEventIds = ['assignment', 'comment'] as const;

export type GitHubNotificationEventId = (typeof githubNotificationEventIds)[number];

export interface GitHubNotificationTurnIdentity {
  eventId: GitHubNotificationEventId;
  lifecycleId: GitHubNotificationLifecycleId;
  modeId: GitHubNotificationModeId;
}

function isGitHubNotificationEventId(value: unknown): value is GitHubNotificationEventId {
  return githubNotificationEventIds.includes(value as GitHubNotificationEventId);
}

/** Decode channel-owned turn selection without accepting provider prose. */
export function decodeGitHubNotificationTurnIdentity(
  value: unknown,
): GitHubNotificationTurnIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    !isGitHubNotificationEventId(candidate.eventId) ||
    !isGitHubNotificationLifecycleId(candidate.lifecycleId) ||
    !isGitHubNotificationModeId(candidate.modeId)
  ) {
    return undefined;
  }
  return {
    eventId: candidate.eventId,
    lifecycleId: candidate.lifecycleId,
    modeId: candidate.modeId,
  };
}

export function githubNotificationTurnChatContext(identity: GitHubNotificationTurnIdentity) {
  return { [githubNotificationTurnContextKey]: identity };
}
