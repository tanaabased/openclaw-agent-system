import type {
  GitHubNotificationIntakeState,
  GitHubNotificationItemState,
} from '../intake/monitor/state.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';

export const githubNotificationLifecycleIds = [
  'issue',
  'pull-request',
  'pull-request-review',
] as const;

export type GitHubNotificationLifecycleId = (typeof githubNotificationLifecycleIds)[number];

export function isGitHubNotificationLifecycleId(
  value: unknown,
): value is GitHubNotificationLifecycleId {
  return githubNotificationLifecycleIds.includes(value as GitHubNotificationLifecycleId);
}

export interface GitHubNotificationLifecycleBoundaryInput {
  agentId: string;
  intake: GitHubNotificationIntakeState;
  item: GitHubNotificationItemState;
  signal?: AbortSignal;
  workspaceDir: string;
}

export interface GitHubNotificationLifecycleWorktree {
  branch: string;
  path: string;
}

export interface GitHubNotificationLifecycleContextInput {
  item: GitHubNotificationItemState;
  worktree?: GitHubNotificationLifecycleWorktree;
}

export interface GitHubNotificationLifecycleContextOwner {
  project(input: GitHubNotificationLifecycleContextInput): Readonly<Record<string, unknown>>;
}

export interface GitHubNotificationLifecycleModeSupport {
  instructions?: string;
}

export type GitHubNotificationLifecycleModeSupportMap = Partial<
  Record<GitHubNotificationModeId, GitHubNotificationLifecycleModeSupport>
>;

export interface GitHubNotificationLifecycleAssignmentSessionProjection {
  card: {
    emoji: string;
    summary: string;
    title: string;
  };
  sender: {
    id: string;
    label: string;
  };
  timestamp: number;
}

export type GitHubNotificationLifecycleAssignmentSessionOwner =
  | { enabled: false }
  | {
      enabled: true;
      project(
        item: GitHubNotificationItemState,
      ): GitHubNotificationLifecycleAssignmentSessionProjection;
    };

export type GitHubNotificationLifecycleCommentTurnOwner = { enabled: false } | { enabled: true };

export type GitHubNotificationLifecycleWorktreeOwner =
  | { required: false }
  | {
      inspect(
        input: GitHubNotificationLifecycleBoundaryInput,
      ): Promise<GitHubNotificationLifecycleWorktree | undefined>;
      prepare(
        input: GitHubNotificationLifecycleBoundaryInput,
      ): Promise<GitHubNotificationLifecycleWorktree>;
      required: true;
    };

/** Own lifecycle-specific intake resources behind one classified boundary. */
export interface GitHubNotificationLifecycle {
  readonly assignmentSession: GitHubNotificationLifecycleAssignmentSessionOwner;
  readonly commentTurns: GitHubNotificationLifecycleCommentTurnOwner;
  readonly context: GitHubNotificationLifecycleContextOwner;
  readonly id: GitHubNotificationLifecycleId;
  readonly instructions: string;
  readonly modeSupport: GitHubNotificationLifecycleModeSupportMap;
  readonly worktree: GitHubNotificationLifecycleWorktreeOwner;
}
