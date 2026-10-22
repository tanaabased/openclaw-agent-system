import assert from 'node:assert/strict';
import {
  feedbackAuthorityDigest,
  notificationAuthorityDigest,
} from '../agent/notification-authority.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('agent/notification policy provenance', () => {
  it('should key default feedback by current parent actors and preserve equivalent legacy grants', () => {
    const policy = intakeFixture().policy;
    const inherited = feedbackAuthorityDigest(policy);
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    assert.equal(feedbackAuthorityDigest(policy), inherited);
    delete policy.issueAssignment!.feedback;
    policy.issueAssignment!.allowed = [{ login: 'other', nodeId: 'U_other' }];
    assert.notEqual(feedbackAuthorityDigest(policy), inherited);
    policy.issueAssignment!.feedback = { inherit: false, allowed: [] };
    const replacement = feedbackAuthorityDigest(policy);
    policy.issueAssignment!.allowed = [];
    assert.equal(feedbackAuthorityDigest(policy), replacement);
    policy.issueAssignment!.feedback = { inherit: false, allowed: [] };
    assert.equal(feedbackAuthorityDigest(policy), replacement);
    policy.issueAssignment!.paused = true;
    assert.equal(feedbackAuthorityDigest(policy), replacement);
  });
  it('should canonicalize observation cache keys without mutating configuration', () => {
    const policy = intakeFixture().policy;
    policy.runtimes = ['codex', 'openclaw'];
    policy.allowedRepositoryOwners.push({ login: 'second', nodeId: 'O_second' });
    policy.issueAssignment!.allowed.push({
      login: 'other',
      nodeId: 'U_other',
    });
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    policy.issueAssignment!.pullRequest = {
      recipients: [
        { login: 'receiver', nodeId: 'U_receiver', roles: ['assignee', 'reviewer'] },
        { source: 'assignment-actor', roles: ['assignee'] },
      ],
    };
    const original = structuredClone(policy);
    const workflow = notificationAuthorityDigest(policy),
      reply = feedbackAuthorityDigest(policy);
    assert.deepEqual(policy, original);
    policy.runtimes.reverse();
    policy.allowedRepositoryOwners.reverse();
    policy.issueAssignment!.allowed.reverse();
    policy.issueAssignment!.pullRequest.recipients!.reverse();
    for (const recipient of policy.issueAssignment!.pullRequest.recipients!)
      recipient.roles.reverse();
    assert.equal(notificationAuthorityDigest(policy), workflow);
    assert.equal(feedbackAuthorityDigest(policy), reply);
    policy.issueAssignment!.allowed[0]!.nodeId = 'U_changed';
    assert.notEqual(notificationAuthorityDigest(policy), workflow);
  });
});
