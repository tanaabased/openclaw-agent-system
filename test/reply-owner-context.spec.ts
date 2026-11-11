import assert from 'node:assert/strict';

import type { DeliveryAnnouncementState } from '../agent/delivery-announcement-state.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import replyOwnerContext from '../agent/reply-owner-context.ts';
import replyOwner from '../agent/reply-owner.ts';
import type { ReplyTarget } from '../agent/reply-target.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('agent/reply-owner-context', () => {
  const fixture = () => {
    const github = intakeFixture();
    const record: SharedDispatchRecord = {
      id: 'owner',
      intakeId: 'admission',
      issueKey: 'issue',
      sourceThreadId: 'intake',

      createdAt: 1,
      manifestDigest: 'manifest',
      threadId: 'chat',
      request: {},
    };
    return {
      record,
      caller: 'chat',
      custodyInvalid: false,
      intake: {
        repository: github.repository,
        issue: github.item,
        receiving: github.client.identity,
      },
    };
  };
  it('should project one issue and delivery owner without changing native custody evidence', () => {
    const input = fixture();
    const delivery = { pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 } };
    const context = replyOwnerContext({ ...input, delivery, incarnation: 'native-session' });
    assert.equal(context.id, 'owner');
    assert.equal(context.repository, 'owner/repo');
    assert.equal(context.number, 3);
    assert.equal(context.pullRequestNumber, 7);
    assert.equal(context.publisherLogin, input.intake.receiving.login);
    assert.equal(context.incarnation, 'native-session');
    assert.equal(context.inactive, false);
    assert.equal(context.deliveredPullRequest, delivery.pullRequest);
  });
  it('should reject a missing admission for the calling managed chat without claiming unrelated work', () => {
    const input = fixture();
    assert.throws(
      () => replyOwnerContext({ ...input, intake: undefined }),
      /reply-managed-context-invalid/,
    );
    assert.equal(
      replyOwnerContext({ ...input, caller: 'other', intake: undefined }).repository,
      undefined,
    );
  });
  it('should retain both native custody failure and shared lifecycle inactivity', () => {
    const input = fixture();
    assert.equal(replyOwnerContext({ ...input, custodyInvalid: true }).inactive, true);
    assert.equal(
      replyOwnerContext({ ...input, record: { ...input.record, nativeInactive: true } }).inactive,
      false,
    );
    for (const record of [
      { ...input.record, reset: { at: 1, by: 'operator' } },
      { ...input.record, supersededBy: 'successor' },
    ])
      assert.equal(replyOwnerContext({ ...input, record }).inactive, true);
  });
  it('should supply current delivery evidence to replies and progress updates', () => {
    const input = fixture();
    const owner = replyOwnerContext({
      ...input,
      delivery: { pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 } },
    });
    const target = { owner: 'owner', name: 'repo', number: 3 } as ReplyTarget;
    for (const purpose of [undefined, 'status-update'] as const) {
      const response = replyOwner([owner], 'chat', 'chat', target, purpose);
      assert.ok(response && 'verifiedOutcome' in response);
      assert.deepEqual(response.verifiedOutcome, { delivery: owner.deliveredPullRequest });
    }
  });
  it('should keep source-bound reply ownership after clearing the current pr association', () => {
    const input = fixture();
    const owner = replyOwnerContext({
      ...input,
      conversation: true,
      record: {
        ...input.record,
        pullRequestLink: null,
        feedback: {
          events: [
            {
              id: 'c'.repeat(64),
              sourceId: 'comment',
              nodeId: 'old-pr',
              number: 7,
              itemType: 'pull-request',
              source: '{}',
              revision: 'd'.repeat(64),
              createdAt: 1,
              phase: 'delivered',
            },
          ],
        },
      },
    });
    const target = {
      owner: 'owner',
      name: 'repo',
      number: 7,
      nodeId: 'old-pr',
      source: { nodeId: 'comment' },
    } as ReplyTarget;
    const reply = replyOwner([owner], 'chat', 'chat', target, 'status-update');
    assert.equal(reply?.status, 'status-update-context');
    assert.equal(reply && 'ownerId' in reply && reply.ownerId, input.record.id);
    assert.equal(owner.pullRequestNumber, undefined);
  });
  it('should expose a confirmed announcement only at its original destination', () => {
    const input = fixture();
    const announcement = {
      authorId: input.intake.receiving.nodeId,
      receipt: { nodeId: 'C_ready', databaseId: 99 },
    } as DeliveryAnnouncementState;
    input.record.announcement = announcement;
    const owner = replyOwnerContext(input);
    const destination = 'https://github.com/owner/repo/issues/3';
    const target = { owner: 'owner', name: 'repo', number: 3, destination } as ReplyTarget;
    for (const purpose of [undefined, 'status-update'] as const) {
      const context = replyOwner([owner], 'chat', 'chat', target, purpose);
      assert.ok(context && 'verifiedOutcome' in context && context.verifiedOutcome);
      assert.deepEqual(context.verifiedOutcome.announcement, {
        destination,
        url: destination + '#issuecomment-99',
      });
    }
    owner.pullRequestNumber = 7;
    const other = replyOwner([owner], 'chat', 'chat', {
      ...target,
      number: 7,
      destination: 'https://github.com/owner/repo/pull/7',
    });
    assert.ok(other && 'verifiedOutcome' in other && other.verifiedOutcome);
    assert.equal(other.verifiedOutcome.announcement, undefined);
    for (const changed of [
      { ...announcement, receipt: undefined, attempted: true },
      { ...announcement, code: 'delivery-announcement-unconfirmed' },
      { ...announcement, authorId: 'another-account' },
    ])
      assert.equal(
        replyOwnerContext({ ...input, record: { ...input.record, announcement: changed } })
          .announcement,
        undefined,
      );
    assert.equal(
      replyOwnerContext({
        ...input,
        record: {
          ...input.record,
          announcement,
          announcementRecovery: { status: 'needs-attention' } as NonNullable<
            typeof input.record.announcementRecovery
          >,
        },
      }).announcement,
      undefined,
    );
  });
});
