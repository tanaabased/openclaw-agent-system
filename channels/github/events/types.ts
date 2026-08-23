import type { GitHubNotificationPublicationIntent } from '../publication/publication.ts';

export const githubNotificationEventIds = [
  'assignment',
  'assignment-clarification',
  'comment',
] as const;

export type GitHubNotificationEventId = (typeof githubNotificationEventIds)[number];

export function isGitHubNotificationEventId(value: unknown): value is GitHubNotificationEventId {
  return githubNotificationEventIds.includes(value as GitHubNotificationEventId);
}

export type GitHubNotificationEventTurn =
  | { kind: 'observe-only' }
  | {
      instructions: string;
      kind: 'model';
      publicationIntent: GitHubNotificationPublicationIntent;
      responseInstructions: string;
    };

/** Declare one trusted channel event without selecting lifecycle or mode support. */
export interface GitHubNotificationEvent {
  readonly id: GitHubNotificationEventId;
  readonly turn: GitHubNotificationEventTurn;
}
