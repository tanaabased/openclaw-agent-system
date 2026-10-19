import assert from 'node:assert/strict';

import reactivate, {
  revalidateFeedbackAssignment,
} from '../agent/assignment-feedback-reactivation.ts';
import revalidateAssignment from '../agent/dispatch-assignment.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { FeedbackSourceState } from '../agent/feedback-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { account, baseline, intakeFixture } from './github-intake-fixture.ts';

function fixture() {
  const provider = intakeFixture();
  provider.policy.issueAssignment!.feedback = true;
  const intake = {
    receiving: account,
    repository: provider.repository,
    issue: { ...provider.item },
    assignment: provider.events[0],
  } as unknown as IntakeRecord;
  provider.item.assignees = [];
  provider.events.push({
    ...provider.events[0]!,
    nodeId: 'unassigned',
    databaseId: 31,
    event: 'unassigned',
    createdAt: new Date(baseline + 120_000).toISOString(),
  });
  const record = {
    id: 'r',
    intakeId: 'i',
    issueKey: 'k',
    sourceThreadId: 'owner',
    phase: 'complete',
    createdAt: baseline,
    manifestDigest: 'd',
    retirement: {
      reason: 'assignment-removed',
      at: baseline + 180_000,
      checkedAt: baseline + 180_000,
      eligibleAt: baseline + 3_780_000,
      intakeId: 'i',
    },
  } satisfies SharedDispatchRecord as SharedDispatchRecord & { feedback?: FeedbackSourceState };
  const comment = {
    nodeId: 'comment',
    databaseId: 42,
    body: '@receiver explain the plan',
    bodyTruncated: false,
    author: account,
    createdAt: new Date(baseline + 150_000).toISOString(),
    updatedAt: new Date(baseline + 150_000).toISOString(),
  };
  const comments = [comment];
  const policy = { policy: provider.policy, username: 'receiver', digest: 'digest' };
  const input = {
    record,
    intake,
    policy,
    client: provider.client,
    now: baseline + 180_000,
    save: async () => {},
    comments: async () => ({
      identity: account,
      listIssueComments: async () => ({ comments, truncated: false }),
      getIssueComment: async () => comment,
      findOwnIssueComment: async () => undefined,
      createIssueComment: async () => {
        throw new Error('must not publish');
      },
    }),
  };
  return { provider, record, comment, comments, input, run: () => reactivate(input) };
}

describe('assignment feedback reactivation', () => {
  it('should admit a comment between unassignment and the first poll without granting implementation', async () => {
    const h = fixture();
    assert.equal(await h.run(), true);
    assert.equal(h.record.feedback?.events.length, 1);
    assert.equal(h.record.feedbackReactivation?.assignmentEventId, 'unassigned');
    assert.equal(
      await revalidateFeedbackAssignment(
        h.input.policy,
        h.input.intake,
        h.provider.client,
        h.record,
      ),
      h.provider.repository,
    );
    await assert.rejects(
      revalidateAssignment(h.input.policy, h.input.intake, h.provider.client),
      /dispatch-assignment-removed/,
    );
    h.record.feedback!.events[0]!.phase = 'published';
    assert.equal(await h.run(), true);
    assert.equal(h.record.feedback!.events.length, 1);
  });
  for (const existing of [false, true]) {
    it(`should admit same-second feedback with ${existing ? 'existing' : 'new'} discovery state once`, async () => {
      const h = fixture();
      const boundary = h.provider.events.at(-1)!.createdAt;
      h.comment.createdAt = boundary;
      h.comment.updatedAt = boundary;
      if (existing) h.record.feedback = { startedAt: baseline, baseline: {}, events: [] };
      assert.equal(await h.run(), true);
      assert.equal(h.record.feedback!.events.length, 1);
      assert.equal(h.record.feedback!.events[0]!.createdAt, Date.parse(boundary));
      h.record.feedback!.events[0]!.phase = 'published';
      assert.equal(await h.run(), true);
      assert.equal(h.record.feedback!.events.length, 1);
    });
  }
  it('should exclude feedback immediately before the reactivation boundary', async () => {
    const h = fixture();
    h.comment.createdAt = h.comment.updatedAt = new Date(
      Date.parse(h.provider.events.at(-1)!.createdAt) - 1,
    ).toISOString();
    assert.equal(await h.run(), false);
    assert.equal(h.record.feedback!.events.length, 0);
  });
  it('should retain comment reactivation after unrelated workflow changes', async () => {
    const h = fixture();
    assert.equal(await h.run(), true);
    h.provider.policy.intervalMinutes += 1;
    h.provider.policy.maxConcurrentItems += 1;
    h.provider.policy.cleanup = { enabled: false, graceMinutes: 30 };
    h.provider.policy.issueAssignment!.mode = 'work';
    await revalidateFeedbackAssignment(h.input.policy, h.input.intake, h.provider.client, h.record);
    assert.equal(await h.run(), true);
    assert.equal(h.record.feedback!.events.length, 1);
  });
  for (const kind of [
    'old',
    'unapproved',
    'quoted',
    'incidental',
    'disabled',
    'own-reply',
    'own-summary',
  ] as const) {
    it(`should not reactivate from ${kind} feedback`, async () => {
      const h = fixture();
      if (kind === 'old') h.comment.updatedAt = new Date(baseline + 60_000).toISOString();
      if (kind === 'unapproved') h.comment.author = { ...account, nodeId: 'other' };
      if (kind === 'quoted') h.comment.body = '> @receiver explain';
      if (kind === 'incidental') h.comment.body = 'An ordinary comment.';
      if (kind === 'disabled') h.provider.policy.issueAssignment!.feedback = false;
      if (kind === 'own-summary')
        h.record.assessmentSummaries = [
          { receipt: { nodeId: 'comment', databaseId: 42 } },
        ] as SharedDispatchRecord['assessmentSummaries'];
      if (kind === 'own-reply')
        h.record.feedback = {
          startedAt: baseline,
          baseline: {},
          events: [
            { receipt: { nodeId: 'comment', databaseId: 42 } },
          ] as FeedbackSourceState['events'],
        };
      assert.equal(await h.run(), false);
      assert.equal(h.record.feedbackReactivation, undefined);
    });
  }
  it('should invalidate reactivation on a later assignment event and require a newer comment', async () => {
    const h = fixture();
    await h.run();
    h.provider.events.push({
      ...h.provider.events.at(-1)!,
      nodeId: 'later-unassignment',
      databaseId: 33,
      createdAt: new Date(baseline + 170_000).toISOString(),
    });
    await assert.rejects(
      revalidateFeedbackAssignment(h.input.policy, h.input.intake, h.provider.client, h.record),
      /feedback-reactivation-superseded/,
    );
    assert.equal(await h.run(), false);
    assert.equal(h.record.feedbackReactivation, undefined);
    h.comment.updatedAt = new Date(baseline + 175_000).toISOString();
    h.comment.body = '@receiver new question';
    assert.equal(await h.run(), true);
  });
  it('should require a fresh comment after closure and reject closed or changed provider identities', async () => {
    const h = fixture();
    h.record.retirement!.reactivationAfter = baseline + 160_000;
    assert.equal(await h.run(), false);
    h.provider.item.state = 'closed';
    await assert.rejects(h.run(), /dispatch-issue-closed/);
    h.provider.item.state = 'open';
    h.provider.repository.nodeId = 'foreign';
    h.input.intake.repository = { ...h.provider.repository, nodeId: 'original' };
    await assert.rejects(h.run(), /dispatch-repository-identity-changed/);
  });
  it('should not revive a retained event after its source was deleted', async () => {
    const h = fixture();
    await h.run();
    delete h.record.feedbackReactivation;
    h.comments.length = 0;
    assert.equal(await h.run(), false);
  });
});
