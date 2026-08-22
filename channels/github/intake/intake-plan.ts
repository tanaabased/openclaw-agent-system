import type { GitHubNotificationLifecycleWorktree } from '../lifecycles/types.ts';
import type { GitHubNotificationIntakeState } from './monitor/state.ts';

export interface GitHubNotificationIntakeObservation {
  authority: { authorized: boolean; reasonCode?: string };
  retirementReasonCode?: string;
  retirementRequested?: boolean;
  worktree?: GitHubNotificationLifecycleWorktree;
}

export type GitHubNotificationIntakeAction =
  | { kind: 'mark-prepared'; worktree?: GitHubNotificationLifecycleWorktree }
  | { kind: 'none' }
  | { kind: 'prepare-worktree' }
  | { kind: 'retire'; reasonCode: string };

/** Plan one intake step from current authority and lifecycle-owned resources. */
export default function planGitHubNotificationIntake(
  intake: GitHubNotificationIntakeState,
  observation: GitHubNotificationIntakeObservation,
  worktreeRequired: boolean,
): GitHubNotificationIntakeAction {
  if (intake.stage === 'retired') return { kind: 'none' };
  if (observation.retirementRequested || !observation.authority.authorized) {
    return {
      kind: 'retire',
      reasonCode:
        observation.retirementReasonCode ??
        observation.authority.reasonCode ??
        'github-notification-authority-revoked',
    };
  }
  if (intake.stage === 'prepared') return { kind: 'none' };
  if (!worktreeRequired) return { kind: 'mark-prepared' };
  return observation.worktree
    ? { kind: 'mark-prepared', worktree: observation.worktree }
    : { kind: 'prepare-worktree' };
}
