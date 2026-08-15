import type { GitHubNotificationDeliveryState } from './monitor-state.ts';

export interface GitHubNotificationObservedWorktree {
  branch: string;
  path: string;
}

export interface GitHubNotificationDeliveryObservation {
  authority: { authorized: boolean; reasonCode?: string };
  retirementReasonCode?: string;
  retirementRequested?: boolean;
  worktree?: GitHubNotificationObservedWorktree;
}

export type GitHubNotificationDeliveryAction =
  | { kind: 'checkpoint-worktree'; worktree: GitHubNotificationObservedWorktree }
  | { kind: 'none' }
  | { kind: 'prepare-worktree' }
  | { kind: 'retire'; reasonCode: string };

/** Plan one delivery step from freshly observed side effects instead of trusting its saved stage. */
export function planGitHubNotificationDelivery(
  delivery: GitHubNotificationDeliveryState,
  observation: GitHubNotificationDeliveryObservation,
  worktreeRequired = true,
): GitHubNotificationDeliveryAction {
  if (delivery.stage === 'retired') return { kind: 'none' };
  if (observation.retirementRequested || !observation.authority.authorized) {
    const reasonCode =
      observation.retirementReasonCode ??
      observation.authority.reasonCode ??
      'github-notification-authority-revoked';
    return { kind: 'retire', reasonCode };
  }
  if (delivery.stage === 'active') return { kind: 'none' };
  if (delivery.stage === 'received') return { kind: 'none' };
  if (!worktreeRequired) return { kind: 'none' };
  if (!observation.worktree) return { kind: 'prepare-worktree' };
  if (
    delivery.worktreeBranch !== observation.worktree.branch ||
    delivery.worktreePath !== observation.worktree.path
  ) {
    return { kind: 'checkpoint-worktree', worktree: observation.worktree };
  }
  return { kind: 'none' };
}
