import assert from 'node:assert/strict';

import assessmentOwner from '../agent/assessment-owner.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import managedOwner from '../agent/managed-owner.ts';
import replyOwner from '../agent/reply-owner.ts';
import replyOwnerContext from '../agent/reply-owner-context.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('agent/managed-owner', () => {
  const fixture = intakeFixture();
  const admission = {
    id: 'admitted',
    repository: fixture.repository,
    issue: fixture.item,
    receiving: { login: 'receiver' },
  };
  const current = {
    id: 'current',
    intakeId: 'admitted',
    threadId: 'current-chat',
    request: {},
    context: '{}',
    assessment: {},
    worktree: '/tmp/current',
  } as unknown as SharedDispatchRecord;
  const retired = {
    ...current,
    id: 'retired',
    threadId: 'retired-chat',
    retired: { at: 1, by: 'operator' },
  } as SharedDispatchRecord;
  const reset = {
    ...current,
    id: 'reset',
    threadId: 'reset-chat',
    reset: { at: 1, by: 'operator' },
  } as SharedDispatchRecord;
  const target = { repository: 'owner/repo', number: 3 };
  const assess = (records: SharedDispatchRecord[], session = 'current-chat') =>
    assessmentOwner(records, [admission] as never, session, target);
  const reply = (records: SharedDispatchRecord[], session = 'current-chat', number = 3) =>
    replyOwner(
      records.map((record) =>
        replyOwnerContext({
          record,
          intake: admission as never,
          caller: session,
          custodyInvalid: !record.request,
          delivery:
            record === current
              ? {
                  pullRequest: { pullRequestNodeId: 'pr', pullRequestNumber: 10 },
                  announcement: {
                    attempted: true,
                    receipt: { nodeId: 'announcement', databaseId: 1 },
                  },
                }
              : undefined,
        }),
      ),
      session,
      session,
      { owner: 'owner', name: 'repo', number } as never,
      'status-update',
    );

  it('should resolve current work independently of retained history and record order', () => {
    for (const records of [
      [retired, reset, current],
      [current, reset, retired],
    ]) {
      assert.equal(assess(records)?.record, current);
      for (const number of [3, 10]) {
        const result = reply(records, 'current-chat', number);
        assert.ok(result && 'ownerId' in result);
        assert.equal(result.ownerId, current.id);
      }
    }
  });

  it('should retain historical-only ownership rather than allow unmanaged fallback', () => {
    assert.equal(managedOwner([retired, reset], 'new-chat', () => true).status, 'historical');
    assert.throws(() => assess([retired, reset], 'new-chat'), /assessment-managed-context-invalid/);
    assert.throws(() => reply([retired, reset], 'new-chat'), /reply-managed-owner-required/);
    assert.equal(assess([], 'new-chat'), undefined);
    assert.equal(reply([], 'new-chat'), undefined);
  });

  it('should reject retired callers even when a replacement owns the same issue', () => {
    for (const session of ['retired-chat', 'reset-chat']) {
      assert.throws(
        () => assess([retired, reset, current], session),
        /assessment-managed-context-invalid/,
      );
      assert.throws(
        () => reply([retired, reset, current], session),
        /reply-managed-context-invalid/,
      );
    }
  });

  it('should preserve genuine conflicts and invalid current ownership', () => {
    const competing = { ...current, id: 'competing', threadId: 'other-chat' };
    assert.throws(() => assess([current, competing]), /assessment-managed-owner-ambiguous/);
    assert.throws(() => reply([current, competing]), /reply-managed-owner-ambiguous/);
    for (const changes of [{ nativeInactive: true }, { retirement: {} }, { request: undefined }]) {
      const invalid = { ...current, ...changes } as SharedDispatchRecord;
      assert.throws(() => assess([retired, invalid]), /assessment-managed-context-invalid/);
      assert.throws(() => reply([retired, invalid]), /reply-managed-context-invalid/);
      const competingInvalid = { ...invalid, id: 'invalid', threadId: 'invalid-chat' };
      assert.throws(
        () => assess([current, competingInvalid]),
        /assessment-managed-owner-ambiguous/,
      );
      assert.throws(() => reply([current, competingInvalid]), /reply-managed-owner-ambiguous/);
    }
    assert.throws(() => assess([current], 'another-chat'), /assessment-managed-context-invalid/);
    assert.throws(() => reply([current], 'another-chat'), /reply-managed-owner-required/);
  });

  it('should not select a current record by guessing from a reused caller identity', () => {
    const reused = { ...retired, threadId: current.threadId };
    assert.equal(managedOwner([reused, current], 'current-chat', () => true).status, 'ambiguous');
  });
});
