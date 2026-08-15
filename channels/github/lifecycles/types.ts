import type {
  GitHubNotificationDeliveryState,
  GitHubNotificationItemState,
} from '../utils/monitor-state.ts';

export type GitHubNotificationLifecycleId = 'issue' | 'pull-request' | 'pull-request-review';

export interface GitHubNotificationLifecycleBoundaryInput {
  agentId: string;
  delivery: GitHubNotificationDeliveryState;
  item: GitHubNotificationItemState;
  signal?: AbortSignal;
  workspaceDir: string;
}

export interface GitHubNotificationLifecycleWorktree {
  branch: string;
  path: string;
}

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
  readonly id: GitHubNotificationLifecycleId;
  readonly worktree: GitHubNotificationLifecycleWorktreeOwner;
}
