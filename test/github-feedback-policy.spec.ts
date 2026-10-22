import assert from 'node:assert/strict';
import {
  feedbackIdentities,
  workflowFeedbackAccepting,
  workflowFeedbackAvailable,
} from '../channels/github/feedback-policy.ts';
import parseAgentManifest from '../manifest/parse.ts';

const actor = { name: 'actor', 'node-id': 'U_actor' };
const reviewer = { login: 'reviewer', 'node-id': 'U_reviewer' };
function parse(workflow: Record<string, unknown> = {}) {
  return parseAgentManifest(
    JSON.stringify({
      'schema-version': 1,
      agent: { id: 'test' },
      github: {
        'schema-version': 3,
        username: 'receiver',
        'allowed-repository-owners': [{ owner: 'owner', 'node-id': 'O_owner' }],
        'issue-assignment': { allowed: [actor], reviewers: [reviewer], ...workflow },
      },
    }),
  );
}

describe('channels/github/feedback-policy', () => {
  it('should derive one author set from actors and reviewers for every customization form', () => {
    for (const feedback of [undefined, {}, { skill: '$company:reply', guidance: 'Be concise.' }]) {
      const result = parse({
        feedback,
        reviewers: [reviewer, { login: 'ACTOR', 'node-id': 'U_actor' }],
      });
      assert.ok(result.status === 'valid');
      const workflow = result.manifest.github!.notifications!.issueAssignment!;
      assert.deepEqual(feedbackIdentities(workflow.allowed, workflow.feedback), [
        { login: 'actor', nodeId: 'U_actor' },
        { login: 'reviewer', nodeId: 'U_reviewer' },
      ]);
      if (feedback?.skill)
        assert.equal(
          typeof workflow.feedback === 'object' && workflow.feedback.skill,
          'company:reply',
        );
    }
  });

  it('should preserve parent machinery and live reviewer authority through pause and empty actor lists', () => {
    const result = parse({ paused: true, allowed: [] });
    assert.ok(result.status === 'valid');
    const policy = result.manifest.github!.notifications!;
    assert.equal(workflowFeedbackAvailable(policy, 'issue-assignment'), true);
    assert.equal(workflowFeedbackAccepting(policy, 'issue-assignment'), true);
    assert.equal(workflowFeedbackAvailable(policy, 'review-request'), false);
    assert.ok(typeof policy.issueAssignment!.feedback === 'object');
    policy.issueAssignment!.feedback.allowed = [];
    assert.equal(workflowFeedbackAccepting(policy, 'issue-assignment'), false);
    assert.equal(workflowFeedbackAvailable(policy, 'issue-assignment'), true);
  });

  it('should reject independent author switches, conflicting pins and invalid customization', () => {
    for (const feedback of [
      true,
      false,
      { allowed: [] },
      { inherit: false },
      { guidance: '' },
      { unknown: true },
    ])
      assert.equal(parse({ feedback }).status, 'invalid');
    assert.equal(
      parse({ reviewers: [{ login: 'actor', 'node-id': 'U_other' }] }).status,
      'invalid',
    );
  });

  it('should open admission for unresolved references without granting feedback authority', () => {
    for (const reviewers of [['@reviewer'], ['U_reviewer']]) {
      const result = parse({ allowed: [], reviewers });
      assert.ok(result.status === 'valid');
      const policy = result.manifest.github!.notifications!;
      const workflow = policy.issueAssignment!;
      assert.equal(workflowFeedbackAccepting(policy, 'issue-assignment'), true);
      assert.throws(
        () => feedbackIdentities(workflow.allowed, workflow.feedback),
        /github-notification-feedback-identity-conflict/u,
      );
    }
    assert.throws(
      () =>
        feedbackIdentities([{ login: 'actor', nodeId: 'U_actor' }], {
          inherit: true,
          allowed: [{ login: 'actor', nodeId: 'U_other' }],
        }),
      /github-notification-feedback-identity-conflict/u,
    );
  });
});
