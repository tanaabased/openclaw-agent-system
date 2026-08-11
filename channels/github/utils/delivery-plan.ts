import type { GitHubNotificationDeliveryState } from './monitor-state.ts';

export interface GitHubNotificationObservedWorktree {
  branch: string;
  path: string;
}

export interface GitHubNotificationObservedSession {
  id?: string;
  key: string;
  status: 'active' | 'briefing-running' | 'ready' | 'retired';
}

export interface GitHubNotificationDeliveryObservation {
  authority: { authorized: boolean; reasonCode?: string };
  session?: GitHubNotificationObservedSession;
  worktree?: GitHubNotificationObservedWorktree;
}

export type GitHubNotificationDeliveryAction =
  | { kind: 'checkpoint-session'; session: GitHubNotificationObservedSession }
  | { kind: 'checkpoint-worktree'; worktree: GitHubNotificationObservedWorktree }
  | { kind: 'dispatch-briefing' }
  | { kind: 'none' }
  | { kind: 'prepare-session' }
  | { kind: 'prepare-worktree' }
  | { kind: 'retire'; reasonCode: string };

/** Plan one delivery step from freshly observed side effects instead of trusting its saved stage. */
export function planGitHubNotificationDelivery(
  delivery: GitHubNotificationDeliveryState,
  observation: GitHubNotificationDeliveryObservation,
): GitHubNotificationDeliveryAction {
  if (delivery.stage === 'retired') return { kind: 'none' };
  if (!observation.authority.authorized) {
    return {
      kind: 'retire',
      reasonCode: observation.authority.reasonCode ?? 'github-notification-authority-revoked',
    };
  }
  if (!observation.worktree) return { kind: 'prepare-worktree' };
  if (
    delivery.worktreeBranch !== observation.worktree.branch ||
    delivery.worktreePath !== observation.worktree.path
  ) {
    return { kind: 'checkpoint-worktree', worktree: observation.worktree };
  }
  if (!observation.session) return { kind: 'prepare-session' };
  if (observation.session.status === 'retired') {
    return { kind: 'retire', reasonCode: 'github-notification-session-retired' };
  }
  const observedStage =
    observation.session.status === 'ready' ? 'session-ready' : observation.session.status;
  if (
    delivery.sessionKey !== observation.session.key ||
    delivery.sessionId !== observation.session.id ||
    delivery.stage !== observedStage
  ) {
    return { kind: 'checkpoint-session', session: observation.session };
  }
  return delivery.stage === 'session-ready' ? { kind: 'dispatch-briefing' } : { kind: 'none' };
}
