import assert from 'node:assert/strict';

import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import replyOwnerContext from '../agent/reply-owner-context.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('agent/reply-owner-context', () => {
  const fixture = () => {
    const github = intakeFixture();
    const record: SharedDispatchRecord = {
      id: 'owner',
      intakeId: 'admission',
      issueKey: 'issue',
      sourceThreadId: 'intake',
      phase: 'complete',
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
    assert.equal(context.delivery, delivery);
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
      { ...input.record, retired: { at: 1, by: 'operator' } },
      { ...input.record, reset: { at: 1, by: 'operator' } },
    ])
      assert.equal(replyOwnerContext({ ...input, record }).inactive, true);
  });
  it('should distinguish missing uncertain delivered and blocked announcements from their receipts', () => {
    const input = fixture();
    const receipt = { nodeId: 'announcement', databaseId: 9 };
    for (const [announcement, pending, attempted] of [
      [undefined, true, false],
      [{ attempted: true }, true, true],
      [{ attempted: true, receipt }, false, true],
      [{ attempted: true, receipt, code: 'publication-denied' }, true, true],
    ] as const) {
      const context = replyOwnerContext({
        ...input,
        delivery: {
          pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
          announcement,
        },
      });
      assert.equal(context.announcementPending, pending);
      assert.equal(context.announcementAttempted, attempted);
    }
  });
});
