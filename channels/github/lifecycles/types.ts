import type { GitHubNotificationAssignmentEventProjection } from '../events/assignment.ts';
import type {
  GitHubNotificationIntakeState,
  GitHubNotificationItemState,
} from '../intake/monitor/state.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';
import type { GitHubNotificationItemContext } from '../provider/work-event-client.ts';

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

export interface GitHubNotificationLifecycleWorktreeCleanup {
  status: 'dirty' | 'failed' | 'missing' | 'removed' | 'unsafe';
}

export interface GitHubNotificationLifecycleContextInput {
  item: GitHubNotificationItemState;
  itemContext?: GitHubNotificationItemContext;
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

export interface GitHubNotificationLifecycleAssignmentEventSupport {
  session?: {
    project(
      input: GitHubNotificationLifecycleContextInput,
    ): GitHubNotificationAssignmentEventProjection;
  };
}

export type GitHubNotificationLifecycleCommentEventSupport = Record<string, never>;

export type GitHubNotificationLifecycleImplementationEventSupport = Record<string, never>;

export interface GitHubNotificationLifecycleEventSupportMap {
  assignment?: GitHubNotificationLifecycleAssignmentEventSupport;
  comment?: GitHubNotificationLifecycleCommentEventSupport;
  implementation?: GitHubNotificationLifecycleImplementationEventSupport;
}

export type GitHubNotificationLifecycleWorktreeOwner =
  | { required: false }
  | {
      cleanup(
        input: GitHubNotificationLifecycleBoundaryInput & {
          worktree: GitHubNotificationLifecycleWorktree;
        },
      ): Promise<GitHubNotificationLifecycleWorktreeCleanup>;
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
  readonly context: GitHubNotificationLifecycleContextOwner;
  readonly eventSupport: GitHubNotificationLifecycleEventSupportMap;
  readonly id: GitHubNotificationLifecycleId;
  readonly instructions: string;
  readonly modeSupport: GitHubNotificationLifecycleModeSupportMap;
  readonly worktree: GitHubNotificationLifecycleWorktreeOwner;
}
