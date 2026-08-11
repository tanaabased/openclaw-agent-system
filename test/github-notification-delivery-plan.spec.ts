import assert from 'node:assert/strict';

import { planGitHubNotificationDelivery } from '../channels/github/utils/delivery-plan.ts';
import type { GitHubNotificationDeliveryState } from '../channels/github/utils/monitor-state.ts';

const admitted: GitHubNotificationDeliveryState = {
  assignmentEventId: 'EV_assignment',
  briefingIdempotencyKey: 'EV_assignment',
  schemaVersion: 1,
  stage: 'admitted',
  workId: 'issue-7',
};
const worktree = { branch: 'issue-7-branch', path: '/workspace/worktrees/issue-7' };
const authority = { authorized: true };

describe('channels/github/utils/delivery-plan', () => {
  it('should retire before planning local work when authority is revoked', () => {
    assert.deepEqual(
      planGitHubNotificationDelivery(admitted, {
        authority: { authorized: false, reasonCode: 'item-unassigned' },
      }),
      { kind: 'retire', reasonCode: 'item-unassigned' },
    );
  });

  it('should reconcile observed worktree and session facts before dispatch', () => {
    assert.deepEqual(planGitHubNotificationDelivery(admitted, { authority, worktree }), {
      kind: 'checkpoint-worktree',
      worktree,
    });
    const worktreeReady: GitHubNotificationDeliveryState = {
      ...admitted,
      stage: 'worktree-ready',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    assert.deepEqual(planGitHubNotificationDelivery(worktreeReady, { authority, worktree }), {
      kind: 'prepare-session',
    });
    const session = { key: 'agent:tanaabot:github:item', status: 'ready' as const };
    assert.deepEqual(
      planGitHubNotificationDelivery(worktreeReady, { authority, session, worktree }),
      { kind: 'checkpoint-session', session },
    );
    assert.deepEqual(
      planGitHubNotificationDelivery(
        { ...worktreeReady, sessionKey: session.key, stage: 'session-ready' },
        { authority, session, worktree },
      ),
      { kind: 'dispatch-briefing' },
    );
  });

  it('should trust an active stage only when the observed session agrees', () => {
    const session = {
      id: 'session-id',
      key: 'agent:tanaabot:github:item',
      status: 'active' as const,
    };
    const delivery: GitHubNotificationDeliveryState = {
      ...admitted,
      sessionId: session.id,
      sessionKey: session.key,
      stage: 'active',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };

    assert.deepEqual(planGitHubNotificationDelivery(delivery, { authority, session, worktree }), {
      kind: 'none',
    });
    assert.deepEqual(planGitHubNotificationDelivery(delivery, { authority }), {
      kind: 'prepare-worktree',
    });
  });
});
