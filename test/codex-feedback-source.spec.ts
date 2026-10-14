import assert from 'node:assert/strict';

import { admitCodexFeedback, discoverCodexFeedback } from '../agent/codex-feedback-source.ts';
import type { CodexFeedback } from '../agent/codex-feedback-state.ts';
import { account, intakeFixture } from './github-intake-fixture.ts';
import {
  reviewFixture,
  reviewCommentFixture,
  reviewClientFixture,
} from './github-review-fixtures.ts';

const comment = (nodeId: string, body = '@receiver explain this') => ({
  nodeId,
  body,
  bodyTruncated: false,
  databaseId: 42,
  author: account,
  createdAt: '2026-10-13T01:00:00Z',
  updatedAt: '2026-10-13T01:00:00Z',
});
describe('agent/codex-feedback-source', () => {
  it('should admit configured human self-feedback and reject changed pins or quoted mentions', () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = true;
    assert.equal(admitCodexFeedback(policy, account, comment('C')).disposition, 'approved');
    assert.equal(
      admitCodexFeedback(policy, account, comment('C', '> @receiver do this')).disposition,
      'rejected',
    );
    assert.equal(
      admitCodexFeedback(policy, account, {
        ...comment('C'),
        author: { ...account, nodeId: 'foreign' },
      }).disposition,
      'rejected',
    );
    policy.issueAssignment!.feedback = false;
    assert.equal(admitCodexFeedback(policy, account, comment('C')).disposition, 'rejected');
  });
  it('should baseline once, queue exact edits once and suppress confirmed own replies', async () => {
    const state: CodexFeedback = { baseline: {}, events: [] };
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = true;
    const comments = [comment('old')];
    let truncated = false;
    const input = {
      state,
      policy,
      owner: 'owner',
      name: 'repo',
      number: 3,
      nodeId: 'I_issue',
      itemType: 'issue' as const,
      now: 10,
      client: {
        identity: account,
        listIssueComments: async () => ({ comments, truncated }),
        getIssueComment: async () => comments[0]!,
      },
    };
    await discoverCodexFeedback(input);
    assert.equal(state.events.length, 0);
    comments.push(comment('new'));
    comments.push(comment('new'));
    await discoverCodexFeedback(input);
    await discoverCodexFeedback(input);
    assert.equal(state.events.length, 1);
    const frozen = state.events[0]!.source;
    comments[1] = comment('new', '@receiver changed question');
    comments[2] = comments[1];
    await discoverCodexFeedback(input);
    assert.equal(state.events.length, 2);
    assert.equal(state.events[0]!.source, frozen);
    state.events[0]!.receipt = { nodeId: 'own', databaseId: 99 };
    comments.push(comment('own'));
    await discoverCodexFeedback(input);
    assert.equal(state.events.length, 2);
    const before = structuredClone(state);
    truncated = true;
    await assert.rejects(discoverCodexFeedback(input), /feedback-source-incomplete/);
    assert.deepEqual(state, before);
  });
  it('should admit a new source on a resource discovered after monitoring began', async () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = true;
    const state: CodexFeedback = {
      startedAt: Date.parse('2026-10-12T00:00:00Z'),
      baseline: {},
      events: [],
    };
    await discoverCodexFeedback({
      state,
      policy,
      owner: 'owner',
      name: 'repo',
      number: 3,
      nodeId: 'new-resource',
      itemType: 'issue',
      now: Date.parse('2026-10-13T02:00:00Z'),
      client: {
        identity: account,
        listIssueComments: async () => ({ comments: [comment('new')], truncated: false }),
        getIssueComment: async () => comment('new'),
      },
    });
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]!.createdAt, Date.parse('2026-10-13T01:00:00Z'));
  });
  it('should preserve grouped review context and admit a later inline reply separately', async () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = true;
    const state: CodexFeedback = { baseline: { PR: {} }, events: [] };
    const review = reviewFixture({ author: account, body: '@receiver explain the finding' });
    const finding = reviewCommentFixture({ author: account });
    const comments = [finding];
    const client = {
      identity: account,
      listIssueComments: async () => ({ comments: [], truncated: false }),
      getIssueComment: async () => comment('C'),
      reviews: reviewClientFixture(review, comments),
    };
    const input = {
      state,
      policy,
      client,
      owner: 'owner',
      name: 'repo',
      number: 3,
      nodeId: 'PR',
      itemType: 'pull-request' as const,
      now: 10,
    };
    await discoverCodexFeedback(input);
    assert.equal(state.events.length, 1);
    const group = JSON.parse(state.events[0]!.source);
    assert.equal(group.feedback.comments[0].line, null);
    comments.push(
      reviewCommentFixture({
        nodeId: 'reply',
        databaseId: 85,
        author: account,
        replyToId: finding.databaseId,
        createdAt: '2026-10-13T01:00:00Z',
        body: '@receiver follow-up',
      }),
    );
    await discoverCodexFeedback(input);
    assert.equal(state.events.length, 2);
    assert.equal(JSON.parse(state.events[1]!.source).feedback.receipt.kind, 'review-comment');
  });
});
