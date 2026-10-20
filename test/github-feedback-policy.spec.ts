import assert from 'node:assert/strict';

import { stringify } from 'yaml';

import { feedbackIdentities, workflowFeedbackEnabled } from '../channels/github/feedback-policy.ts';
import parseAgentManifest from '../manifest/parse.ts';

const pirog = { login: 'pirog', nodeId: 'U_pirog' };
const smutlord = { login: 'smutlord', nodeId: 'U_smutlord' };
const pin = ({ login, nodeId }: typeof pirog) => ({ login, 'node-id': nodeId });
const parse = (notifications: unknown) =>
  parseAgentManifest(
    stringify({
      'schema-version': 1,
      agent: { id: 'test' },
      github: {
        username: 'emori',
        notifications: {
          'schema-version': 2,
          runtimes: ['codex'],
          'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
          ...(notifications as object),
        },
      },
    }),
  );

describe('channels/github/feedback-policy', () => {
  it('should default to three shared slots and preserve an explicit limit', () => {
    for (const limit of [undefined, 2, 5]) {
      const parsed = parse(limit === undefined ? {} : { 'max-concurrent-items': limit });
      assert.ok(parsed.status === 'valid');
      assert.equal(parsed.manifest.github!.notifications!.schemaVersion, 2);
      assert.equal(parsed.manifest.github!.notifications!.maxConcurrentItems, limit ?? 3);
    }
  });
  it('should distinguish off, inheritance, replacement and augmentation without copying parent grants', () => {
    assert.deepEqual(feedbackIdentities([pirog], undefined), []);
    assert.deepEqual(feedbackIdentities([pirog], false), []);
    assert.deepEqual(feedbackIdentities([pirog], true), [pirog]);
    assert.deepEqual(feedbackIdentities([pirog], { inherit: false, allowed: [smutlord] }), [
      smutlord,
    ]);
    assert.deepEqual(
      feedbackIdentities([pirog], {
        inherit: true,
        allowed: [smutlord, pirog, { ...pirog, login: 'PIROG' }],
      }),
      [pirog, smutlord],
    );
    assert.deepEqual(feedbackIdentities([], { inherit: true, allowed: [smutlord] }), [smutlord]);
  });
  it('should distinguish feedback enablement from workflow disablement and an empty author set', () => {
    const parsed = parse({
      'issue-assignment': { mode: 'plan', allowed: [pin(pirog)], feedback: true },
    });
    assert.equal(parsed.status, 'valid');
    if (parsed.status !== 'valid') return;
    const policy = parsed.manifest.github!.notifications!;
    assert.equal(workflowFeedbackEnabled(policy, 'issue-assignment'), true);
    policy.issueAssignment!.enabled = false;
    assert.equal(workflowFeedbackEnabled(policy, 'issue-assignment'), false);
    policy.issueAssignment!.enabled = true;
    policy.issueAssignment!.allowed = [];
    assert.equal(workflowFeedbackEnabled(policy, 'issue-assignment'), false);
    policy.issueAssignment!.feedback = { inherit: false, allowed: [smutlord] };
    assert.equal(workflowFeedbackEnabled(policy, 'issue-assignment'), true);
  });

  it('should reject conflicting pins instead of choosing a login or node id', () => {
    for (const other of [
      { ...pirog, nodeId: 'U_other' },
      { ...pirog, login: 'renamed' },
    ])
      assert.throws(
        () => feedbackIdentities([pirog], { inherit: true, allowed: [other] }),
        /feedback-identity-conflict/,
      );
  });
  it('should normalize object defaults and reject removed global feedback even when disabled', () => {
    const defaults = parse({ 'issue-assignment': { feedback: {} } });
    assert.ok(defaults.status === 'valid');
    const policy = defaults.manifest.github!.notifications;
    assert.ok(policy?.schemaVersion === 2);
    assert.deepEqual(policy.issueAssignment!.feedback, { inherit: false, allowed: [] });
    for (const feedback of [false, { enabled: false }, { allowed: [pin(pirog)] }]) {
      const parsed = parse({ feedback, 'issue-assignment': { feedback: true } });
      assert.equal(parsed.status, 'invalid');
      assert.ok(
        parsed.diagnostics.some(
          ({ code }) => code === 'github-notification-global-feedback-removed',
        ),
      );
    }
    for (const feedback of [
      { enabled: true },
      { inherit: 'true' },
      { allowed: [{ login: 'missing' }] },
      { allowed: [{ ...pin(pirog), 'operator-owner': true }] },
    ])
      assert.equal(parse({ 'issue-assignment': { feedback } }).status, 'invalid');
  });
  it('should decode independent reply composition without implicitly granting feedback authority', () => {
    const parsed = parse({
      'issue-assignment': {
        allowed: [pin(pirog)],
        feedback: { skill: '$company:reply', guidance: 'Keep it short.\nUse our voice.' },
      },
      'review-request': {
        allowed: [pin(smutlord)],
        feedback: { guidance: { file: 'guidance/reply.md' } },
      },
    });
    assert.ok(parsed.status === 'valid');
    const policy = parsed.manifest.github!.notifications!;
    assert.ok(policy.schemaVersion === 2);
    assert.deepEqual(policy.issueAssignment!.feedback, {
      inherit: false,
      allowed: [],
      skill: 'company:reply',
      guidance: 'Keep it short.\nUse our voice.',
    });
    assert.deepEqual(policy.reviewRequest!.feedback, {
      inherit: false,
      allowed: [],
      guidance: { file: 'guidance/reply.md' },
    });
    assert.equal(workflowFeedbackEnabled(policy, 'issue-assignment'), false);
    assert.equal(workflowFeedbackEnabled(policy, 'review-request'), false);
    for (const feedback of [{ skill: '../file' }, { guidance: { file: '' } }])
      assert.equal(parse({ 'issue-assignment': { feedback } }).status, 'invalid');
  });
  it('should diagnose conflicting effective feedback pins during manifest validation', () => {
    const parsed = parse({
      'issue-assignment': {
        allowed: [pin(pirog)],
        feedback: { inherit: true, allowed: [{ login: 'PIROG', 'node-id': 'U_other' }] },
      },
    });
    assert.equal(parsed.status, 'invalid');
    assert.ok(
      parsed.diagnostics.some(
        ({ code }) => code === 'github-notification-feedback-identity-conflict',
      ),
    );
  });
  it('should parse implementation and review selections through the same trusted configuration shape', () => {
    const parsed = parse({
      'issue-assignment': {
        implementation: { skill: '$company:implement', guidance: { file: 'guidance/work.md' } },
      },
      'review-request': { review: { skill: 'company:review', guidance: 'Explain failed tests.' } },
    });
    assert.ok(parsed.status === 'valid');
    const policy = parsed.manifest.github!.notifications;
    assert.ok(policy?.schemaVersion === 2);
    assert.deepEqual(policy.issueAssignment!.implementation, {
      skill: 'company:implement',
      guidance: { file: 'guidance/work.md' },
    });
    assert.equal(policy.reviewRequest!.review!.skill, 'company:review');
    for (const skill of ['../file', 'do arbitrary work'])
      assert.equal(parse({ 'review-request': { review: { skill } } }).status, 'invalid');
  });
});
