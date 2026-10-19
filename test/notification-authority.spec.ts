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
  it('should preserve grants when schema-owned sets are reordered without mutating configuration', () => {
    const policy = intakeFixture().policy;
    policy.runtimes = ['codex', 'openclaw'];
    policy.allowedRepositoryOwners.push({ login: 'second', nodeId: 'O_second' });
    policy.issueAssignment!.allowed.push({
      login: 'other',
      nodeId: 'U_other',
      operatorOwner: true,
    });
    policy.issueAssignment!.feedback = true;
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
    assert.ok(matchesNotificationAuthority(workflow, policy));
    assert.ok(matchesFeedbackAuthority(reply, policy));
    policy.issueAssignment!.allowed[0]!.operatorOwner = false;
    assert.equal(matchesNotificationAuthority(workflow, policy), false);
  });
  it('should accept unchanged order-sensitive receipts but reject changed grants', () => {
    const policy = intakeFixture().policy;
    policy.runtimes = ['openclaw', 'codex'];
    policy.issueAssignment!.feedback = true;
    const oldWorkflow = automationHash({
      schemaVersion: policy.schemaVersion,
      runtimes: policy.runtimes,
      cleanup: { enabled: true },
      allowedRepositoryOwners: policy.allowedRepositoryOwners,
      issueAssignment: policy.issueAssignment,
      reviewRequest: policy.reviewRequest,
    });
    const oldReply = automationHash({
      effect: 'feedback-reply',
      schemaVersion: policy.schemaVersion,
      runtimes: policy.runtimes,
      allowedRepositoryOwners: policy.allowedRepositoryOwners,
      enabled: true,
      authors: policy.issueAssignment!.allowed.map(({ login, nodeId }) => ({ login, nodeId })),
    });
    assert.ok(matchesNotificationAuthority(oldWorkflow, policy));
    assert.ok(matchesFeedbackAuthority(oldReply, policy));
    policy.allowedRepositoryOwners = [];
    assert.equal(matchesNotificationAuthority(oldWorkflow, policy), false);
    assert.equal(matchesFeedbackAuthority(oldReply, policy), false);
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
