import assert from 'node:assert/strict';
import {
  feedbackAuthorityDigest,
  matchesFeedbackAuthority,
  matchesNotificationAuthority,
  notificationAuthorityDigest,
} from '../agent/notification-authority.ts';
import { automationHash } from '../agent/automation-hash.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('agent/feedback reply authority', () => {
  it('should ignore work settings without turning a reply grant into workflow authority', () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = true;
    const digest = feedbackAuthorityDigest(policy);
    policy.issueAssignment!.mode = 'work';
    policy.issueAssignment!.implementation = { skill: 'custom:implementation' };
    policy.issueAssignment!.assessment = { guidance: 'Changed planning guidance.' };
    policy.cleanup = { enabled: false, graceMinutes: 5 };
    policy.issueAssignment!.feedback = {
      inherit: true,
      allowed: [],
      guidance: 'New reply guidance.',
    };
    assert.ok(matchesFeedbackAuthority(digest, policy));
    assert.equal(matchesNotificationAuthority(digest, policy), false);
  });
  for (const change of ['runtime', 'repository', 'actor', 'disabled', 'feedback'] as const)
    it(`should revoke a reply grant when ${change} changes`, () => {
      const policy = intakeFixture().policy;
      policy.issueAssignment!.feedback = true;
      const digest = feedbackAuthorityDigest(policy);
      if (change === 'runtime') policy.runtimes = [];
      if (change === 'repository') policy.allowedRepositoryOwners = [];
      if (change === 'actor') policy.issueAssignment!.allowed = [];
      if (change === 'disabled') policy.issueAssignment!.enabled = false;
      if (change === 'feedback') policy.issueAssignment!.feedback = false;
      assert.equal(matchesFeedbackAuthority(digest, policy), false);
    });
  it('should accept unchanged legacy grants without broadening them after a policy change', () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = true;
    for (const digest of [notificationAuthorityDigest(policy), automationHash(policy)]) {
      assert.ok(matchesFeedbackAuthority(digest, policy));
      const changed = structuredClone(policy);
      changed.issueAssignment!.mode = 'work';
      assert.equal(matchesFeedbackAuthority(digest, changed), false);
    }
  });
});
