import assert from 'node:assert/strict';
import { stringify } from 'yaml';

import parse, { normalizeAgentManifest } from '../manifest/parse.ts';
import mergeManifestDocuments from '../manifest/merge-documents.ts';
import { wantsGitHubChannel } from '../channels/github/channel-config.ts';
import sessionDispatchRequirements from '../agent/session-dispatch-requirements.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import recipients from '../channels/github/pull-request-recipients.ts';

const actor = { login: 'operator', 'node-id': 'U_operator' };
const reviewer = { name: 'reviewer', 'node-id': 'U_reviewer' };
const base = {
  'schema-version': 1,
  agent: { id: 'v3-test' },
  github: {
    'schema-version': 3,
    username: 'agent',
    'allowed-repository-owners': [{ org: 'owner', 'node-id': 'O_owner' }],
    'issue-assignment': {},
  },
};
function load(github: Record<string, unknown> = {}) {
  const result = parse(stringify({ ...base, github: { ...base.github, ...github } }));
  assert.equal(result.status, 'valid', JSON.stringify(result.diagnostics));
  if (result.status !== 'valid') throw new Error('invalid fixture');
  return result;
}

describe('channels/github/v3 configuration', () => {
  it('should apply defaults and provision an explicitly declared empty workflow', () => {
    const { manifest } = load();
    const policy = manifest.github!.notifications!;
    assert.equal(policy.schemaVersion, 3);
    assert.deepEqual(policy.runtimes, ['openclaw', 'codex']);
    assert.equal(policy.intervalMinutes, 5);
    assert.equal(policy.maxConcurrentItems, 3);
    assert.deepEqual(policy.issueAssignment!.allowed, []);
    assert.equal(policy.issueAssignment!.mode, 'auto');
    assert.equal(policy.issueAssignment!.paused, false);
    assert.equal(wantsGitHubChannel(manifest), true);
    assert.deepEqual(
      sessionDispatchRequirements(manifest).map(({ id }) => id),
      ['github-issue-assignment'],
    );
  });

  it('should normalize name aliases and derive reviewer feedback and original-actor delivery', () => {
    const { manifest } = load({
      'issue-assignment': {
        allowed: [actor],
        reviewers: [reviewer],
        feedback: { guidance: 'Be concise.' },
      },
    });
    const workflow = manifest.github!.notifications!.issueAssignment!;
    assert.deepEqual(feedbackIdentities(workflow.allowed, workflow.feedback), [
      { login: 'operator', nodeId: 'U_operator' },
      { login: 'reviewer', nodeId: 'U_reviewer' },
    ]);
    assert.deepEqual(
      recipients(workflow.pullRequest!.recipients, { login: 'assigner', nodeId: 'U_assigner' }),
      {
        assignees: [{ login: 'assigner', nodeId: 'U_assigner' }],
        reviewers: [{ login: 'reviewer', nodeId: 'U_reviewer' }],
      },
    );
  });

  it('should preserve authority across aliases, yaml list forms and explicit defaults', () => {
    const expected = load({ 'issue-assignment': { allowed: [actor] } }).manifest;
    for (const alias of ['login', 'name', 'owner', 'org']) {
      for (const flow of [false, true]) {
        const result = parse(
          stringify(
            {
              ...base,
              github: {
                ...base.github,
                runtimes: ['openclaw', 'codex'],
                'interval-minutes': 5,
                'max-concurrent-items': 3,
                'issue-assignment': {
                  paused: false,
                  allowed: [{ [alias]: actor.login, 'node-id': actor['node-id'] }],
                  mode: 'auto',
                  reviewers: [],
                  feedback: {},
                },
              },
            },
            { collectionStyle: flow ? 'flow' : 'block' },
          ),
        );
        assert.equal(result.status, 'valid');
        if (result.status !== 'valid') throw new Error('invalid alias fixture');
        assert.deepEqual(result.manifest, expected);
      }
    }
  });

  it('should preserve compact inputs for authorized resolution without provider access', () => {
    const { manifest } = load({
      'issue-assignment': { allowed: ['@operator', 'U_reviewer', actor] },
    });
    assert.deepEqual(manifest.github!.notifications!.issueAssignment!.allowed, [
      { login: 'operator', nodeId: '', reference: '@operator' },
      { login: '', nodeId: 'U_reviewer', reference: 'U_reviewer' },
      { login: 'operator', nodeId: 'U_operator' },
    ]);
  });

  it('should select v3 completely and attribute the ignored block diagnostic', () => {
    const { manifest, diagnostics } = load({ notifications: { malformed: true } });
    assert.equal(manifest.github!.notifications!.intervalMinutes, 5);
    assert.deepEqual(
      diagnostics.map(({ code, fieldPath }) => ({ code, fieldPath })),
      [{ code: 'github-v2-ignored', fieldPath: '/github/notifications' }],
    );
  });

  it('should reject invalid selected configuration without fallback', () => {
    for (const workflow of [
      { enabled: true },
      { feedback: false },
      { feedback: { allowed: [] } },
      { allowed: [{ ...actor, name: actor.login }] },
      { allowed: [{ ...actor, 'operator-owner': true }] },
      { 'pull-request': {} },
    ]) {
      const result = normalizeAgentManifest({
        ...base,
        github: { ...base.github, notifications: {}, 'issue-assignment': workflow },
      });
      assert.equal(result.status, 'invalid', JSON.stringify(workflow));
    }
  });

  it('should replace overlay lists and keep absent or unsupported workflows inactive', () => {
    const merged = mergeManifestDocuments(
      {
        path: 'agent.yaml',
        value: { ...base, github: { ...base.github, 'issue-assignment': { allowed: [actor] } } },
      },
      { path: 'agent.local.yaml', value: { github: { 'issue-assignment': { allowed: [] } } } },
    );
    const result = normalizeAgentManifest(merged.value);
    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') throw new Error('invalid overlay');
    assert.deepEqual(result.manifest.github!.notifications!.issueAssignment!.allowed, []);
    const { manifest } = load({
      'issue-assignment': undefined,
      'review-request': { allowed: [actor] },
    });
    assert.equal(wantsGitHubChannel(manifest), false);
    assert.deepEqual(sessionDispatchRequirements(manifest), []);
  });
});
