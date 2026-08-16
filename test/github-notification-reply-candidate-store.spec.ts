import assert from 'node:assert/strict';

import GitHubNotificationReplyCandidateStore from '../channels/github/lib/reply-candidate-store.ts';

describe('channels/github/lib/reply-candidate-store', () => {
  it('should isolate candidates to one active agent turn', () => {
    const store = new GitHubNotificationReplyCandidateStore();
    const token = store.begin('tanaabot');

    assert.equal(store.hasActive('tanaabot'), true);
    assert.equal(store.hasActive('other-agent'), false);
    store.stage('tanaabot', 'ready');
    assert.deepEqual(store.finish('tanaabot', token), ['ready']);
    assert.equal(store.hasActive('tanaabot'), false);
  });

  it('should reject overlapping turns and stale tokens', () => {
    const store = new GitHubNotificationReplyCandidateStore();
    const token = store.begin('tanaabot');

    assert.throws(() => store.begin('tanaabot'), /already active/u);
    assert.throws(() => store.finish('tanaabot', Symbol('stale')), /no longer active/u);
    store.cancel('tanaabot', token);
    assert.throws(
      () => store.stage('tanaabot', 'late'),
      /No matching GitHub notification reply turn/u,
    );
  });
});
