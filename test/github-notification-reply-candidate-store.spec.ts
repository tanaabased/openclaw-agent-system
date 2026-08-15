import assert from 'node:assert/strict';

import GitHubNotificationReplyCandidateStore from '../channels/github/lib/reply-candidate-store.ts';

describe('channels/github/lib/reply-candidate-store', () => {
  it('should isolate candidates to one active session turn', () => {
    const store = new GitHubNotificationReplyCandidateStore();
    const token = store.begin('session-1');

    assert.equal(store.hasActive('session-1'), true);
    assert.equal(store.hasActive('session-2'), false);
    store.stage('session-1', 'ready');
    assert.deepEqual(store.finish('session-1', token), ['ready']);
    assert.equal(store.hasActive('session-1'), false);
  });

  it('should reject overlapping turns and stale tokens', () => {
    const store = new GitHubNotificationReplyCandidateStore();
    const token = store.begin('session-1');

    assert.throws(() => store.begin('session-1'), /already active/u);
    assert.throws(() => store.finish('session-1', Symbol('stale')), /no longer active/u);
    store.cancel('session-1', token);
    assert.throws(() => store.stage('session-1', 'late'), /No GitHub notification reply turn/u);
  });
});
