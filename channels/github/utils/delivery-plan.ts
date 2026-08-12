import type { GitHubNotificationDeliveryState } from './monitor-state.ts';

export interface GitHubNotificationObservedWorktree {
  branch: string;
  path: string;
}

export interface GitHubNotificationObservedSession {
  id?: string;
  key: string;
  status: 'active' | 'briefing-running' | 'incomplete' | 'ready' | 'retired' | 'retiring';
}

export interface GitHubNotificationDeliveryObservation {
  authority: { authorized: boolean; reasonCode?: string };
  retirementReasonCode?: string;
  retirementRequested?: boolean;
  session?: GitHubNotificationObservedSession;
  worktree?: GitHubNotificationObservedWorktree;
}

export type GitHubNotificationDeliveryAction =
  | { kind: 'checkpoint-session'; session: GitHubNotificationObservedSession }
  | { kind: 'checkpoint-worktree'; worktree: GitHubNotificationObservedWorktree }
  | { kind: 'dispatch-briefing' }
  | { kind: 'fail'; reasonCode: string }
  | { kind: 'none' }
  | { kind: 'prepare-session' }
  | { kind: 'prepare-worktree' }
  | { kind: 'retire-session'; reasonCode: string }
  | { kind: 'retire'; reasonCode: string };

/** Plan one delivery step from freshly observed side effects instead of trusting its saved stage. */
export function planGitHubNotificationDelivery(
  delivery: GitHubNotificationDeliveryState,
  observation: GitHubNotificationDeliveryObservation,
): GitHubNotificationDeliveryAction {
  if (delivery.stage === 'retired') return { kind: 'none' };
  if (observation.retirementRequested || !observation.authority.authorized) {
    const reasonCode =
      observation.retirementReasonCode ??
      observation.authority.reasonCode ??
      'github-notification-authority-revoked';
    if (observation.session && observation.session.status !== 'retired') {
      return { kind: 'retire-session', reasonCode };
    }
    return {
      kind: 'retire',
      reasonCode,
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
  if (observation.session.status === 'retiring') {
    return { kind: 'retire-session', reasonCode: 'github-notification-session-retiring' };
  }
  if (observation.session.status === 'incomplete') {
    return { kind: 'fail', reasonCode: 'github-notification-briefing-incomplete' };
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
