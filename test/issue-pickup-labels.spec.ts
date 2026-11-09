import assert from 'node:assert/strict';

import issuePickupLabels from '../agent/issue-pickup-labels.ts';
import { issuePickupPolicyDigest } from '../agent/issue-pickup-authority.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import fixture from './issue-pickup-selection-fixture.ts';

describe('agent/issue-pickup-labels', () => {
  it('should require all included labels and reject any excluded label without mutating names', () => {
    const labels = ['Bug', 'Ready', 'other'];
    assert.equal(issuePickupLabels(labels), true);
    assert.equal(issuePickupLabels([], {}), true);
    assert.equal(issuePickupLabels([], { labels: [], excludeLabels: [] }), true);
    assert.equal(issuePickupLabels(labels, { labels: ['BUG', 'ready'] }), true);
    assert.equal(issuePickupLabels(labels, { labels: ['bug', 'unknown'] }), false);
    assert.equal(issuePickupLabels(labels, { excludeLabels: ['unknown', 'READY'] }), false);
    assert.equal(issuePickupLabels(labels, { excludeLabels: ['unknown'] }), true);
    assert.equal(issuePickupLabels(labels, { labels: ['bug'], excludeLabels: ['BUG'] }), false);
    assert.deepEqual(labels, ['Bug', 'Ready', 'other']);
  });

  it('should filter paginated candidates independently per project before dependency reads', async () => {
    const f = fixture();
    const other = f.addRepository('other');
    f.policy.issuePickup!.projects[0]!.filters = { labels: ['unknown'] };
    f.policy.issuePickup!.projects.push({
      repository: 'owner/other',
      limit: 1,
      milestone: { number: 10, policy: 'only' },
      filters: { labels: ['PRIORITY: HIGH'] },
    });
    const discover = f.client.discoverProject;
    f.client.discoverProject = async (...args) => ({
      ...(await discover(...args)),
      ...(args[1] === 'repo' && args[3] === 1 ? { nextPage: 2 } : {}),
    });
    f.client.projectBlocked = async (_owner, name) => {
      assert.equal(name, 'other');
      return false;
    };
    assert.equal((await f.run()).status, 'discovering');
    const result = await f.run();
    assert.ok('candidates' in result && result.candidates);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.nodeId),
      [other.items.get(f.item.number)!.nodeId],
    );
    assert.equal(f.effects.writes, 0);
  });

  for (const change of ['remove-required', 'add-excluded', 'irrelevant'] as const) {
    it(`should recheck membership before the write after ${change}`, async () => {
      const f = fixture();
      f.policy.issuePickup!.projects[0]!.filters = {
        labels: ['priority: high'],
        excludeLabels: ['blocked'],
      };
      const selection = await f.select();
      const current = f.candidates.get(f.item.number)!;
      current.title = 'changed title';
      current.body = 'changed body';
      current.labels =
        change === 'remove-required'
          ? []
          : change === 'add-excluded'
            ? ['priority: high', 'blocked']
            : ['priority: high', 'new label'];
      const result = await f.run({ selection });
      assert.equal(result.status, change === 'irrelevant' ? 'assigned' : 'failed');
      assert.equal(f.effects.writes, change === 'irrelevant' ? 1 : 0);
      if (change !== 'irrelevant') assert.equal(result.code, 'issue-pickup-candidate-ineligible');
    });
  }

  it('should recheck selection eligibility after live filter edits without changing enrollment', async () => {
    const f = fixture();
    const digest = issuePickupPolicyDigest(f.policy);
    const selection = await f.select();
    f.policy.issuePickup!.projects[0]!.filters = { labels: ['missing'] };
    assert.equal(issuePickupPolicyDigest(f.policy), digest);
    assert.equal((await f.run({ selection })).status, 'empty');
    f.tx.runId = 'next-scan';
    f.policy.issuePickup!.projects[0]!.filters = { excludeLabels: ['missing'] };
    assert.equal(f.effects.writes, 0);
    assert.equal((await f.run({ selection })).status, 'assigned');
    assert.equal(f.effects.writes, 1);
  });

  it('should preserve read errors and uncertain assignment recovery after filter edits', async () => {
    const f = fixture();
    f.policy.issuePickup!.projects[0]!.filters = { labels: ['priority: high'] };
    const selection = await f.select();
    const read = f.client.projectCandidate;
    f.client.projectCandidate = async () => {
      throw new GitHubWorkEventClientError('github-notification-request-failed', 'read denied');
    };
    const failed = await f.run({ selection });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.code, 'github-notification-request-failed');
    assert.equal(f.effects.writes, 0);
    f.client.projectCandidate = read;
    const assign = f.client.assignProjectIssue;
    f.client.assignProjectIssue = async (...args) => {
      await assign(...args);
      throw new Error('response lost');
    };
    assert.equal((await f.run({ selection: await f.select() })).status, 'attempted');
    f.policy.issuePickup!.projects[0]!.filters = { labels: ['now missing'] };
    f.tx.runId = 'recover';
    assert.equal((await f.run()).status, 'assigned');
    assert.equal(f.effects.writes, 1);
  });
});
