import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { codexFeedbackSchema, type CodexFeedback } from '../agent/codex-feedback-state.ts';
import DiscoveryBudget, { DiscoveryPaused } from '../agent/discovery-budget.ts';
import { observeFeedbackPolicy } from '../agent/feedback-source.ts';
import { openclawFeedbackSchema } from '../agent/openclaw-feedback-state.ts';

import { admitCodexFeedback, discoverCodexFeedback } from '../agent/codex-feedback-source.ts';
import { account, intakeFixture } from './github-intake-fixture.ts';
import {
  reviewClientFixture,
  reviewCommentFixture,
  reviewFixture,
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
  for (const failedRead of ['comments', 'reviews', 'members'] as const) {
    it(`should isolate failed ${failedRead} reads and recover without replay`, async () => {
      const policy = intakeFixture().policy;
      policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
      const state: CodexFeedback = { startedAt: 0, baseline: {}, events: [] };
      const review = reviewFixture({ author: account, body: '@receiver fix this' });
      const members = [reviewCommentFixture({ author: account })];
      const reviews = reviewClientFixture(review, members);
      const originalList = reviews.listReviews;
      const originalMembers = reviews.getReviewComments;
      let failed = true;
      reviews.listReviews = async (...args) => {
        if (failed && failedRead === 'reviews') throw new Error('review-unavailable');
        return originalList(...args);
      };
      reviews.getReviewComments = async (...args) => {
        if (failed && failedRead === 'members') throw new Error('members-unavailable');
        return originalMembers(...args);
      };
      const scan = () =>
        discoverCodexFeedback({
          state,
          policy,
          owner: 'owner',
          name: 'repo',
          number: 3,
          nodeId: 'PR',
          itemType: 'pull-request',
          now: Date.parse('2026-10-14T00:00:00Z'),
          client: {
            identity: account,
            reviews,
            listIssueComments: async () => {
              if (failed && failedRead === 'comments') throw new Error('comments-unavailable');
              return { comments: [comment('ordinary')], truncated: false };
            },
            getIssueComment: async () => comment('ordinary'),
          },
          discovery: { budget: new DiscoveryBudget(), save: async () => {} },
        });
      await assert.rejects(scan(), /unavailable/);
      assert.deepEqual(
        state.events.map((event) => event.sourceId),
        failedRead === 'comments' ? [review.nodeId] : ['ordinary'],
      );
      assert.equal(state.watermarks?.PR, undefined);
      failed = false;
      await scan();
      await scan();
      assert.equal(state.events.length, 2);
      const grouped = JSON.parse(
        state.events.find((event) => event.sourceId === review.nodeId)!.source,
      );
      assert.deepEqual(grouped.feedback.comments, members);
      assert.equal(typeof state.watermarks?.PR, 'number');
    });
  }

  it('should admit unrelated authors while an outgoing lookup fails and revisit deferred self input', async () => {
    const policy = intakeFixture().policy;
    const human = { ...account, login: 'human', nodeId: 'U_human' };
    policy.issueAssignment!.feedback = { inherit: true, allowed: [human] };
    const state: CodexFeedback = { startedAt: 0, baseline: { I: {} }, events: [] };
    const comments = [comment('own'), { ...comment('human'), author: human, databaseId: 43 }];
    let failed = true;
    const scan = () =>
      discoverCodexFeedback({
        state,
        policy,
        owner: 'owner',
        name: 'repo',
        number: 3,
        nodeId: 'I',
        itemType: 'issue',
        now: Date.parse('2026-10-14T00:00:00Z'),
        client: {
          identity: account,
          listIssueComments: async () => ({ comments, truncated: false }),
          getIssueComment: async () => comments[0]!,
        },
        ownCommentIds: async () => {
          if (failed) throw new Error('outgoing lookup unavailable');
          return [];
        },
        discovery: { budget: new DiscoveryBudget(), save: async () => {} },
      });
    await scan();
    assert.deepEqual(
      state.events.map((event) => event.sourceId),
      ['human'],
    );
    assert.equal(state.baseline.I!.own, undefined);
    assert.equal(state.watermarks?.I, undefined);
    failed = false;
    await scan();
    assert.deepEqual(
      state.events.map((event) => event.sourceId),
      ['human', 'own'],
    );
    assert.equal(typeof state.watermarks?.I, 'number');
  });
  it('should persist complete grouped review checkpoints and baselines beyond transport page sizes', async () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    const state: CodexFeedback = { baseline: { PR: {} }, events: [] };
    const review = reviewFixture({ author: account, body: '@receiver address these findings' });
    const findings = [1, 2].map((id) =>
      reviewCommentFixture({
        author: account,
        nodeId: `finding-${id}`,
        databaseId: 100 + id,
        body: `${id}: complete finding`,
        diffHunk: '+complete code context\n'.repeat(12000),
      }),
    );
    let largest = 0;
    const save = async () => {
      for (const progress of Object.values(state.discovery ?? {}))
        for (const read of Object.values(progress.reads)) largest = Math.max(largest, read.length);
      assert.ok(Value.Check(codexFeedbackSchema, state));
      assert.ok(Value.Check(openclawFeedbackSchema, state));
    };
    await discoverCodexFeedback({
      state,
      policy,
      owner: 'owner',
      name: 'repo',
      number: 3,
      nodeId: 'PR',
      itemType: 'pull-request',
      now: 10,
      client: {
        identity: account,
        listIssueComments: async () => ({ comments: [], truncated: false }),
        getIssueComment: async () => comment('C'),
        reviews: reviewClientFixture(review, findings),
      },
      discovery: { budget: new DiscoveryBudget(), save },
    });
    assert.ok(largest > 512000);
    assert.equal(state.events.length, 1);
    const restored = JSON.parse(JSON.stringify(state)) as CodexFeedback;
    assert.deepEqual(JSON.parse(restored.events[0]!.source).feedback.comments, findings);
    assert.ok(Value.Check(codexFeedbackSchema, restored));
    assert.ok(Value.Check(openclawFeedbackSchema, restored));
  });

  it('should reject completed-source replay and own reply receipts while accepting edits', async () => {
    const policy = intakeFixture().policy;
    const state: CodexFeedback = {
      startedAt: Date.parse('2026-10-12T00:00:00Z'),
      baseline: {},
      events: [],
    };
    let comments = [comment('source')];
    const scan = () =>
      discoverCodexFeedback({
        state,
        ownCommentIds: ['own-reply'],
        policy,
        owner: 'owner',
        name: 'repo',
        number: 3,
        nodeId: 'I',
        itemType: 'issue',
        now: Date.parse('2026-10-14T00:00:00Z'),
        client: {
          identity: account,
          listIssueComments: async () => ({ comments, truncated: false }),
          getIssueComment: async () => comments[0]!,
          reviews: reviewClientFixture(reviewFixture({ body: '' }), []),
        },
      });
    await scan();
    const original = state.events[0]!;
    original.phase = 'delivered';
    state.baseline = {};
    comments.push(comment('own-reply'));
    await scan();
    assert.equal(state.events.length, 1);
    comments = [
      { ...comment('source', '@receiver revised question'), updatedAt: '2026-10-13T02:00:00Z' },
    ];
    await scan();
    assert.equal(state.events.length, 2);
    assert.notEqual(state.events[1]!.id, original.id);
    await scan();
    assert.equal(state.events.length, 2);
  });

  it('should discover pause-time feedback after resume without a cutoff or duplicate admission', async () => {
    const policy = intakeFixture().policy;
    const state: CodexFeedback = {
      startedAt: Date.parse('2026-10-12T00:00:00Z'),
      baseline: {},
      events: [],
    };
    policy.issueAssignment!.paused = true;
    observeFeedbackPolicy(state, policy, Date.parse('2026-10-13T00:00:00Z'));
    assert.equal(state.admission?.enabled, true);
    assert.equal(state.admission?.after, undefined);
    const comments = [comment('during-pause')];
    const scan = () =>
      discoverCodexFeedback({
        state,
        policy,
        owner: 'owner',
        name: 'repo',
        number: 3,
        nodeId: 'I',
        itemType: 'issue',
        now: Date.parse('2026-10-13T02:00:00Z'),
        client: {
          identity: account,
          listIssueComments: async () => ({ comments, truncated: false }),
          getIssueComment: async () => comments[0]!,
          reviews: reviewClientFixture(reviewFixture({ body: '' }), []),
        },
      });
    policy.issueAssignment!.paused = false;
    await scan();
    assert.deepEqual(
      state.events.map(({ sourceId }) => sourceId),
      ['during-pause'],
    );
    const receipt = structuredClone(state.events[0]);
    await scan();
    assert.deepEqual(JSON.parse(JSON.stringify(state.events)), [receipt]);
    assert.equal(state.admission?.after, undefined);
  });
  it('should admit configured human self-feedback and reject changed pins or quoted mentions', () => {
    const policy = intakeFixture().policy;
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
    policy.issueAssignment!.feedback = { inherit: false, allowed: [] };
    assert.equal(admitCodexFeedback(policy, account, comment('C')).disposition, 'rejected');
  });
  for (const pause of ['empty-authors'] as const)
    it(`should preserve admission and receipts across ${pause} pause and resume without replaying history`, async () => {
      const startedAt = Date.parse('2026-10-12T00:00:00Z');
      let state: CodexFeedback = { startedAt, baseline: {}, events: [] };
      const policy = intakeFixture().policy;
      const suspend = () => {
        policy.issueAssignment!.feedback = { inherit: false, allowed: [] };
      };
      const resume = () => {
        policy.issueAssignment!.paused = false;
        delete policy.issueAssignment!.feedback;
      };
      suspend();
      const comments: ReturnType<typeof comment>[] = [];
      const at = (id: string, offset: number) => ({
        ...comment(id),
        createdAt: new Date(startedAt + offset).toISOString(),
        updatedAt: new Date(startedAt + offset).toISOString(),
      });
      const run = (offset: number, nodeId = 'I') =>
        discoverCodexFeedback({
          state,
          policy,
          owner: 'owner',
          name: 'repo',
          number: nodeId === 'I' ? 3 : 4,
          nodeId,
          itemType: nodeId === 'I' ? 'issue' : 'pull-request',
          now: startedAt + offset,
          client: {
            identity: account,
            listIssueComments: async () => ({
              comments:
                nodeId === 'I'
                  ? comments
                  : comments.map((source) => ({ ...source, nodeId: source.nodeId + '-pr' })),
              truncated: false,
            }),
            getIssueComment: async () => comments[0]!,
            reviews: reviewClientFixture(reviewFixture({ body: '' }), []),
          },
        });
      await run(0);
      comments.push(at('disabled', 1000));
      await run(2000);
      assert.equal(state.events.length, 0);
      assert.ok(state.baseline.I?.disabled);
      await run(4000);
      state = JSON.parse(JSON.stringify(state));
      comments.push(at('interval', 4500), {
        ...at('unapproved', 4600),
        author: { ...account, nodeId: 'foreign' },
      });
      resume();
      await run(5000);
      assert.equal(state.admission?.after, startedAt + 4000);
      assert.deepEqual(
        state.events.map((event) => event.sourceId),
        ['interval'],
      );
      // late discovery does not admit history before or exactly at the previous check.
      comments.push(at('late-history', 3000), at('boundary', 4000), at('fresh', 6000));
      await run(7000);
      assert.deepEqual(
        state.events.map((event) => event.sourceId),
        ['interval', 'fresh'],
      );
      const admitted = state.events[0]!.id;
      state = JSON.parse(JSON.stringify(state));
      await run(8000);
      assert.equal(state.admission?.after, startedAt + 4000);
      assert.equal(Value.Check(codexFeedbackSchema, state), true);
      assert.equal(Value.Check(openclawFeedbackSchema, state), true);
      assert.equal(state.events.length, 2);
      // the linked pr shares the interval and the author checks.
      await run(9000, 'linked-pr');
      assert.deepEqual(
        state.events.map((event) => event.sourceId),
        ['interval', 'fresh', 'interval-pr', 'fresh-pr'],
      );
      suspend();
      comments.push(at('second-disabled-period', 10000));
      await run(11000);
      assert.equal(state.events[0]!.policyHeld, 'feedback-not-approved');
      resume();
      await run(12000);
      assert.equal(state.admission?.after, startedAt + 11000);
      assert.equal(state.events[0]!.id, admitted);
      assert.equal(state.events[0]!.policyHeld, undefined);
      assert.equal(state.events.length, 4);
      comments[0] = {
        ...comments[0]!,
        body: '@receiver a new revision',
        updatedAt: new Date(startedAt + 13000).toISOString(),
      };
      await run(14000);
      assert.equal(state.events.at(-1)?.sourceId, 'disabled');
      state.events.at(-1)!.phase = 'delivered';
      await run(15000);
      assert.equal(state.events.length, 5);
    });

  it('should baseline once, queue exact edits once and suppress confirmed own replies', async () => {
    const state: CodexFeedback = { baseline: {}, events: [] };
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    const comments = [comment('old')];
    let truncated = false;
    const input = {
      state,
      ownCommentIds: ['own', 'summary'],
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
    comments.push(comment('own'));
    comments.push(comment('summary'));
    comments.push(comment('copied-summary-marker', '@receiver a human copied a summary marker'));
    await discoverCodexFeedback(input);
    assert.equal(state.events.length, 3);
    assert.equal(state.events.at(-1)?.sourceId, 'copied-summary-marker');
    const before = structuredClone(state);
    truncated = true;
    await assert.rejects(discoverCodexFeedback(input), /feedback-source-incomplete/);
    assert.deepEqual(state, before);
  });
  it('should suppress both publication receipts after reading comments and retain same-account human feedback', async () => {
    const state: CodexFeedback = { baseline: { I: {} }, events: [] };
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    const comments = [
      comment('announcement'),
      comment('summary'),
      comment('human'),
      comment(
        'forged',
        '@receiver question <!-- agent-system-github-publication:pull-request-handoff:forged -->',
      ),
    ];
    let commentsRead = false;
    await discoverCodexFeedback({
      state,
      policy,
      owner: 'owner',
      name: 'repo',
      number: 3,
      nodeId: 'I',
      itemType: 'issue',
      now: 10,
      ownCommentIds: async () => {
        assert.equal(commentsRead, true);
        return ['announcement', 'summary'];
      },
      client: {
        identity: account,
        listIssueComments: async () => {
          commentsRead = true;
          return { comments, truncated: false };
        },
        getIssueComment: async () => comments[0]!,
      },
    });
    assert.deepEqual(
      state.events.map((event) => event.sourceId),
      ['human', 'forged'],
    );
  });
  it('should admit a new source on a resource discovered after monitoring began', async () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
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
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
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

  it('should admit a same-timestamp inline reply from its own empty review exactly once', async () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    const state: CodexFeedback = { baseline: { PR: {} }, events: [] };
    const review = reviewFixture({ author: account, body: '' });
    const reply = reviewCommentFixture({
      author: account,
      replyToId: 70,
      body: '@receiver follow-up in this thread',
    });
    const parent = reviewCommentFixture({ databaseId: 70, nodeId: 'parent', reviewId: 60 });
    const reviews = reviewClientFixture(review, [reply, parent]);
    reviews.getReviewComments = async () => [reply];
    const input = {
      state,
      policy,
      owner: 'owner',
      name: 'repo',
      number: 3,
      nodeId: 'PR',
      itemType: 'pull-request' as const,
      now: 10,
      client: {
        identity: account,
        listIssueComments: async () => ({ comments: [], truncated: false }),
        getIssueComment: async () => comment('C'),
        reviews,
      },
    };
    await discoverCodexFeedback(input);
    await discoverCodexFeedback(input);
    assert.equal(state.events.length, 1);
    const source = JSON.parse(state.events[0]!.source);
    assert.equal(source.nodeId, reply.nodeId);
    assert.equal(source.feedback.receipt.kind, 'review-comment');
    assert.equal(source.feedback.comments[0].replyToId, parent.databaseId);
    assert.equal(source.feedback.parent.nodeId, parent.nodeId);
  });
  it('should resume checkpointed pages without moving the cutoff or admitting old history', async () => {
    const start = Date.parse('2026-10-12T00:00:00Z');
    let state: CodexFeedback = { startedAt: start, baseline: {}, events: [] };
    let saved = structuredClone(state);
    let clock = 0;
    const calls: number[] = [];
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    let interrupt = true;
    const client = {
      identity: account,
      getIssueComment: async () => comment('new'),
      listIssueComments: async () => {
        throw new Error('unbounded read');
      },
      listIssueCommentPage: async (
        _o: string,
        _n: string,
        _i: number,
        page: number,
        since: string,
      ) => {
        assert.equal(since, new Date((state.watermarks?.I ?? start) - 2000).toISOString());
        calls.push(page);
        if (interrupt) clock = 20000;
        return {
          comments:
            page === 1
              ? [comment('new')]
              : [{ ...comment('edited'), createdAt: '2026-10-01T00:00:00Z' }],
          truncated: page === 1,
        };
      },
    };
    const run = () =>
      discoverCodexFeedback({
        state,
        policy,
        client,
        owner: 'owner',
        name: 'repo',
        number: 3,
        nodeId: 'I',
        itemType: 'issue',
        now: start + 1000,
        discovery: {
          budget: new DiscoveryBudget(20000, undefined, () => clock),
          save: async () => {
            saved = structuredClone(state);
          },
        },
      });
    await assert.rejects(run(), DiscoveryPaused);
    assert.equal(saved.baseline.I, undefined);
    assert.equal(saved.startedAt, start);
    state = JSON.parse(JSON.stringify(saved));
    interrupt = false;
    clock = 0;
    await run();
    assert.deepEqual(calls, [1, 1, 2]);
    assert.deepEqual(
      state.events.map((event) => event.sourceId),
      ['new', 'edited'],
    );
    assert.equal(state.watermarks!.I, start + 1000);
    assert.equal(state.discovery!.I, undefined);
    await run();
    assert.equal(state.events.length, 2);
  });

  it('should retain a late pr comment across interrupted review reads and restart without advancing past it', async () => {
    const start = Date.parse('2026-10-12T00:00:00Z');
    let state: CodexFeedback = { startedAt: start, baseline: {}, events: [] };
    let saved = structuredClone(state);
    const policy = intakeFixture().policy;
    const late = {
      ...comment('late'),
      updatedAt: new Date(start + 2000).toISOString(),
      createdAt: new Date(start + 2000).toISOString(),
    };
    let arrived = false;
    let pause: 'reviews' | 'review-comments' | undefined = 'reviews';
    let now = start + 1000;
    const reviews = reviewClientFixture(reviewFixture(), []);
    reviews.listReviews = async () => {
      if (pause === 'reviews') throw new DiscoveryPaused();
      return { values: [], nextPage: 1 };
    };
    reviews.listComments = async () => {
      if (pause === 'review-comments') throw new DiscoveryPaused();
      return { values: [], nextPage: 1 };
    };
    const cutoffs: string[] = [];
    const run = () =>
      discoverCodexFeedback({
        state,
        policy,
        owner: 'owner',
        name: 'repo',
        number: 7,
        nodeId: 'PR',
        itemType: 'pull-request',
        now,
        client: {
          identity: account,
          reviews,
          getIssueComment: async () => late,
          listIssueComments: async () => {
            throw new Error('unbounded read');
          },
          listIssueCommentPage: async (_o, _n, _id, page, since) => {
            cutoffs.push(since);
            return { comments: arrived && page === 1 ? [late] : [], truncated: page === 1 };
          },
        },
        discovery: {
          budget: new DiscoveryBudget(),
          save: async () => {
            saved = structuredClone(state);
          },
        },
      });
    await assert.rejects(run(), DiscoveryPaused);
    assert.deepEqual(Object.keys(saved.discovery!.PR!.reads), ['comments:1', 'comments:2']);
    assert.equal(saved.watermarks?.PR, undefined);
    arrived = true;
    state = JSON.parse(JSON.stringify(saved));
    pause = 'review-comments';
    now = start + 3000;
    await assert.rejects(run(), DiscoveryPaused);
    state = JSON.parse(JSON.stringify(saved));
    assert.equal(state.watermarks?.PR, undefined);
    pause = undefined;
    now = start + 4000;
    await run();
    assert.equal(state.watermarks!.PR, start + 1000);
    assert.equal(state.events.length, 0, 'the retained first page predates the late comment');
    assert.ok(cutoffs.every((cutoff) => cutoff === new Date(start - 2000).toISOString()));
    state = JSON.parse(JSON.stringify(saved));
    now = start + 5000;
    await run();
    await run();
    assert.deepEqual(
      state.events.map((event) => event.sourceId),
      ['late'],
    );
    assert.deepEqual(JSON.parse(state.events[0]!.source), late);
  });

  it('should detect an edited historical review without expanding unchanged review members', async () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    const state: CodexFeedback = {
      startedAt: Date.parse('2026-10-12T00:00:00Z'),
      baseline: {},
      events: [],
    };
    const review = reviewFixture({ author: account, body: '@receiver old question' });
    const reviews = reviewClientFixture(review, []);
    let expansions = 0;
    reviews.getReviewComments = async () => {
      expansions++;
      return [];
    };
    const run = () =>
      discoverCodexFeedback({
        state,
        policy,
        owner: 'owner',
        name: 'repo',
        number: 3,
        nodeId: 'PR',
        itemType: 'pull-request',
        now: state.startedAt! + 1000,
        client: {
          identity: account,
          listIssueComments: async () => ({ comments: [], truncated: false }),
          getIssueComment: async () => comment('C'),
          reviews,
        },
        discovery: { budget: new DiscoveryBudget(), save: async () => {} },
      });
    await run();
    await run();
    assert.equal(expansions, 0);
    assert.equal(state.events.length, 0);
    review.body = '@receiver edited question';
    await run();
    await run();
    assert.equal(expansions, 1);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]!.sourceId, review.nodeId);
  });
  it('should baseline disabled review edits and admit a subsequent review edit in the enabled window', async () => {
    const startedAt = Date.parse('2026-10-12T00:00:00Z');
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    const state: CodexFeedback = { startedAt, baseline: {}, events: [] };
    const review = reviewFixture({ author: account, body: '@receiver old question' });
    const reviews = reviewClientFixture(review, []);
    let now = startedAt + 1000;
    const run = () =>
      discoverCodexFeedback({
        state,
        policy,
        owner: 'owner',
        name: 'repo',
        number: 3,
        nodeId: 'PR',
        itemType: 'pull-request',
        now,
        client: {
          identity: account,
          listIssueComments: async () => ({ comments: [], truncated: false }),
          getIssueComment: async () => comment('unused'),
          reviews,
        },
        discovery: { budget: new DiscoveryBudget(), save: async () => {} },
      });
    await run();
    policy.issueAssignment!.feedback = { inherit: false, allowed: [] };
    review.body = '@receiver changed while disabled';
    now += 1000;
    await run();
    assert.equal(state.events.length, 0);
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    now += 1000;
    await run();
    assert.equal(state.events.length, 0);
    review.body = '@receiver changed after enabling';
    now += 1000;
    await run();
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]!.sourceId, review.nodeId);
  });

  it('should restart a shifted page boundary without treating unseen comments as deleted', async () => {
    const policy = intakeFixture().policy;
    policy.issueAssignment!.feedback = { inherit: true, allowed: [] };
    const state: CodexFeedback = { startedAt: 1, baseline: {}, events: [] };
    let clock = 0;
    let shifted = false;
    let pause = true;
    const client = {
      identity: account,
      getIssueComment: async () => comment('a'),
      listIssueComments: async () => {
        throw new Error('unbounded read');
      },
      listIssueCommentPage: async (_o: string, _n: string, _i: number, page: number) => {
        if (pause) clock = 20000;
        return {
          comments: [comment(page === 1 ? (shifted ? 'b' : 'a') : 'c')],
          truncated: page === 1,
        };
      },
    };
    const run = () =>
      discoverCodexFeedback({
        state,
        policy,
        client,
        owner: 'owner',
        name: 'repo',
        number: 3,
        nodeId: 'I',
        itemType: 'issue',
        now: 2,
        discovery: {
          budget: new DiscoveryBudget(20000, undefined, () => clock),
          save: async () => {},
        },
      });
    await assert.rejects(run(), DiscoveryPaused);
    pause = false;
    shifted = true;
    clock = 0;
    await assert.rejects(run(), DiscoveryPaused);
    assert.equal(state.baseline.I, undefined);
    assert.deepEqual(state.discovery!.I!.reads, {});
    await run();
    assert.deepEqual(
      state.events.map((event) => event.sourceId),
      ['b', 'c'],
    );
  });
});
