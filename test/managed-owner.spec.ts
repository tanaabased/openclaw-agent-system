import assert from 'node:assert/strict';

import assessmentOwner from '../agent/assessment-owner.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import managedOwner from '../agent/managed-owner.ts';
import replyOwnerContext from '../agent/reply-owner-context.ts';
import replyOwner from '../agent/reply-owner.ts';
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
    issueKey: 'current-issue',
    threadId: 'current-chat',
    request: {},
    context: '{}',
    assessment: {},
    worktree: '/tmp/current',
  } as unknown as SharedDispatchRecord;
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
                }
              : undefined,
        }),
      ),
      session,
      session,
      { owner: 'owner', name: 'repo', number } as never,
      'status-update',
    );

  it('should preserve the same task owner and context digest while its native chat is idle', () => {
    const idle = { ...current, nativeInactive: true };
    assert.equal(assess([idle])?.record, idle);
    assert.equal(assess([idle])?.digest, assess([current])?.digest);
    assert.ok(reply([idle]));
  });

  it('should isolate unrelated missing admissions without allowing unresolved ownership to fall back', () => {
    const orphan = {
      ...current,
      id: 'orphan',
      intakeId: 'missing',
      threadId: 'other-chat',
      issueKey: 'other-issue',
    };
    assert.equal(assess([orphan, current])?.record, current);
    assert.equal(assess([current, orphan])?.record, current);
    for (const records of [
      [orphan],
      [current, { ...orphan, issueKey: current.issueKey }],
      [current, { ...orphan, issueKey: undefined }],
    ])
      assert.throws(
        () => assess(records as SharedDispatchRecord[]),
        /assessment-managed-admission-missing/,
      );
    assert.throws(
      () => assess([orphan, current], 'other-chat'),
      /assessment-managed-admission-missing/,
    );
    assert.throws(
      () => assess([orphan, current], 'new-chat'),
      /assessment-managed-admission-missing/,
    );
  });

  it('should resolve current work independently of retained history and record order', () => {
    for (const records of [
      [reset, current],
      [current, reset],
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
    assert.equal(managedOwner([reset], 'new-chat', () => true).status, 'historical');
    assert.throws(() => assess([reset], 'new-chat'), /assessment-managed-context-invalid/);
    assert.throws(() => reply([reset], 'new-chat'), /reply-managed-owner-required/);
    assert.equal(assess([], 'new-chat'), undefined);
    assert.equal(reply([], 'new-chat'), undefined);
  });

  it('should reject reset callers even when a replacement owns the same issue', () => {
    for (const session of ['reset-chat']) {
      assert.throws(() => assess([reset, current], session), /assessment-managed-context-invalid/);
      assert.throws(() => reply([reset, current], session), /reply-managed-context-invalid/);
    }
  });

  it('should preserve genuine conflicts and invalid current ownership', () => {
    const competing = { ...current, id: 'competing', threadId: 'other-chat' };
    assert.throws(() => assess([current, competing]), /assessment-managed-owner-ambiguous/);
    assert.throws(() => reply([current, competing]), /reply-managed-owner-ambiguous/);
    for (const changes of [{ retirement: {} }, { request: undefined }]) {
      const invalid = { ...current, ...changes } as SharedDispatchRecord;
      assert.throws(() => assess([reset, invalid]), /assessment-managed-context-invalid/);
      assert.throws(() => reply([reset, invalid]), /reply-managed-context-invalid/);
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

  it('should keep different issues contributing to one pr with their own reply owner', () => {
    const owners = [
      {
        id: 'first',
        threadId: 'first-chat',
        repository: 'owner/repo',
        number: 3,
        pullRequestNumber: 10,
        inactive: false,
      },
      {
        id: 'second',
        threadId: 'second-chat',
        repository: 'owner/repo',
        number: 4,
        pullRequestNumber: 10,
        inactive: false,
      },
    ];
    const target = { owner: 'owner', name: 'repo', number: 10 } as never;
    for (const owner of owners) {
      const result = replyOwner(owners, owner.threadId, owner.threadId, target, 'status-update');
      assert.ok(result && 'ownerId' in result);
      assert.equal(result.ownerId, owner.id);
    }
    assert.throws(
      () => replyOwner(owners, 'unrelated', 'unrelated', target, 'status-update'),
      /reply-managed-owner-ambiguous/,
    );
    assert.throws(
      () =>
        replyOwner(
          [...owners, { ...owners[0]!, id: 'duplicate', threadId: 'duplicate-chat' }],
          'first-chat',
          'first-chat',
          target,
          'status-update',
        ),
      /reply-managed-owner-ambiguous/,
    );
    assert.throws(
      () =>
        replyOwner(
          [{ ...owners[0]!, inactive: true }, owners[1]!],
          'first-chat',
          'first-chat',
          target,
          'status-update',
        ),
      /reply-managed-context-invalid/,
    );
  });

  it('should not select a current record by guessing from a reused caller identity', () => {
    const reused = { ...reset, threadId: current.threadId };
    assert.equal(managedOwner([reused, current], 'current-chat', () => true).status, 'ambiguous');
  });

  it('should keep intentional parallel tasks and their replies with each native caller', () => {
    const additional = {
      ...current,
      id: 'additional',
      intakeId: undefined,
      threadId: 'additional-chat',
      manualIssue: { ...admission, id: 'additional', fresh: true },
    } as unknown as SharedDispatchRecord;
    assert.equal(assess([current, additional])?.record, current);
    assert.equal(assess([current, additional], 'additional-chat')?.record, additional);
    for (const owner of [current, additional]) {
      const result = reply([current, additional], owner.threadId!);
      assert.ok(result && 'ownerId' in result);
      assert.equal(result.ownerId, owner.id);
    }
    const predecessor = { ...current, supersededBy: additional.id };
    assert.throws(() => assess([predecessor, additional]), /context-invalid/);
    assert.throws(() => reply([predecessor, additional]), /context-invalid/);
    const projection = replyOwnerContext({
      record: additional,
      intake: admission as never,
      caller: additional.threadId!,
      custodyInvalid: false,
      delivery: { adopted: {}, pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 } },
    });
    assert.equal(projection.deliveredPullRequest, undefined);
  });
});
