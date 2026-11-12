import assert from 'node:assert/strict';

import feedbackSources from '../agent/tasks/feedback/feedback-sources.ts';
import type { FeedbackSourceState } from '../agent/tasks/feedback/feedback-state.ts';
import type { ManagedIssue } from '../agent/managed-issue.ts';

describe('agent/feedback-sources', () => {
  const intake = { issue: { nodeId: 'issue', number: 3 } } as ManagedIssue;
  const previous = { pullRequestNodeId: 'old', pullRequestNumber: 7 };

  it('should remove deselected scratch without changing accepted effects or observation history', () => {
    const record = {
      id: 'owner',
      delivery: { pullRequest: previous },
      pullRequestLink: { pullRequestNodeId: 'current', pullRequestNumber: 8 },
    };
    const checkpoint = { since: 1, startedAt: 2, reads: { 'comments:1': '{}' } };
    const feedback: FeedbackSourceState = {
      baseline: { old: { comment: 'retained revision' } },
      events: [
        {
          id: 'c'.repeat(64),
          sourceId: 'pending',
          number: 7,
          nodeId: 'old',
          itemType: 'pull-request',
          source: '{"body":"accepted input"}',
          revision: 'd'.repeat(64),
          createdAt: 1,
          phase: 'prepared',
        },
      ],
      discovery: { old: checkpoint, current: checkpoint, issue: checkpoint },
      discoveryStalls: {
        old: { operation: 'source-validation', attempts: 3 },
        current: { operation: 'comments', attempts: 1 },
        owner: { operation: 'occurrence-budget-before-feedback', attempts: 2 },
      },
      watermarks: { old: 1 },
      lastSource: 'old',
      code: 'feedback-discovery-no-progress',
    };
    const before = structuredClone(feedback);
    assert.deepEqual(
      feedbackSources(record, intake, feedback).map((s) => s.nodeId),
      ['issue', 'current'],
    );
    assert.deepEqual(Object.keys(feedback.discovery!), ['current', 'issue']);
    assert.deepEqual(Object.keys(feedback.discoveryStalls!), ['current', 'owner']);
    assert.equal(feedback.lastSource, undefined);
    assert.equal(feedback.code, undefined);
    for (const key of ['baseline', 'events', 'watermarks'] as const)
      assert.deepEqual(feedback[key], before[key]);
    assert.deepEqual(record.delivery.pullRequest, previous);
  });

  it('should keep current-source and owner diagnostics without confusing them with obsolete sources', () => {
    const feedback: FeedbackSourceState = {
      baseline: {},
      events: [],
      discoveryStalls: { owner: { operation: 'workspace-binding', attempts: 3 } },
      code: 'feedback-discovery-no-progress',
    };
    feedbackSources({ id: 'owner', pullRequestLink: null }, intake, feedback);
    assert.equal(feedback.code, 'feedback-discovery-no-progress');
    assert.equal(feedback.discoveryStalls!.owner!.attempts, 3);
    feedback.code = 'feedback-github-rate-limit';
    delete feedback.discoveryStalls;
    feedbackSources({ id: 'owner' }, intake, feedback);
    assert.equal(feedback.code, 'feedback-github-rate-limit');
  });

  it('should honor explicit unlinking instead of reviving a historical receipt', () => {
    const feedback: FeedbackSourceState = {
      baseline: {},
      events: [],
      discovery: { old: { since: 1, startedAt: 2, reads: {} } },
    };
    const sources = feedbackSources(
      {
        id: 'owner',
        pullRequestLink: null,
        delivery: { pullRequest: previous },
      },
      intake,
      feedback,
    );
    assert.deepEqual(
      sources.map((s) => s.nodeId),
      ['issue'],
    );
    assert.deepEqual(feedback.discovery, {});
  });

  it('should preserve the originating pr and avoid selecting it twice', () => {
    const origin = { ...intake, initiation: {}, pullRequest: {} } as ManagedIssue;
    const feedback: FeedbackSourceState = {
      baseline: {},
      events: [],
      lastSource: 'issue',
      discovery: { issue: { since: 1, startedAt: 2, reads: {} } },
    };
    const sources = feedbackSources(
      {
        id: 'owner',
        pullRequestLink: { pullRequestNodeId: 'issue', pullRequestNumber: 3 },
      },
      origin,
      feedback,
    );
    assert.deepEqual(sources, [{ nodeId: 'issue', number: 3, itemType: 'pull-request' }]);
    assert.ok(feedback.discovery!.issue);
  });
});
