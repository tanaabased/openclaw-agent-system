import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import nativeOperatorSelection from '../agent/native-operator-selection.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { ManagedIssue } from '../agent/managed-issue.ts';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';
import { codexRecoveryModelSchema } from '../tools/dispatch/recovery-schema.ts';

describe('native operator task selection', () => {
  const target = 'https://github.com/owner/repo/issues/3';
  const issue = {
    id: 'admission',
    repository: { owner: { login: 'owner' }, name: 'repo' },
    issue: { number: 3 },
  } as ManagedIssue;
  const original = {
    id: 'original',
    intakeId: issue.id,
    sourceThreadId: 'coordinator',
    threadId: 'original-chat',
  } as SharedDispatchRecord;
  it('should retry the sole current assignment independently of retired history ordering', () => {
    const retired = { ...original, retired: { at: 1, by: 'operator' } };
    const waiting = { ...original, id: 'waiting', threadId: undefined, phase: 'waiting' as const };
    for (const records of [[retired, waiting], [waiting, retired], [waiting]])
      assert.equal(
        nativeOperatorSelection({ action: 'retry', target }, records, [issue], 'operator'),
        waiting,
      );
  });
  it('should exclude terminal owners without redirecting an exact retry to a sibling', () => {
    const waiting = { ...original, id: 'waiting', threadId: undefined, phase: 'waiting' as const };
    const excluded: SharedDispatchRecord[] = [
      { ...original, retired: { at: 1, by: 'operator' } },
      {
        ...original,
        retirement: {
          reason: 'assignment-removed',
          at: 1,
          eligibleAt: 1,
        } as SharedDispatchRecord['retirement'],
      },
      { ...original, reset: { at: 1, by: 'operator' } },
      { ...original, supersededBy: waiting.id },
    ];
    for (const previous of excluded) {
      assert.throws(
        () => nativeOperatorSelection({ action: 'retry', target }, [previous], [issue], 'operator'),
        /dispatch-target-unavailable/,
      );
      assert.equal(
        nativeOperatorSelection(
          { action: 'retry', target },
          [previous, waiting],
          [issue],
          'operator',
        ),
        waiting,
      );
      assert.throws(
        () =>
          nativeOperatorSelection(
            { action: 'retry', chat: previous.threadId },
            [previous, waiting],
            [issue],
            'operator',
          ),
        /dispatch-target-unavailable/,
      );
    }
    const sibling = { ...waiting, id: 'sibling', threadId: 'sibling-chat' };
    for (const records of [
      [waiting, sibling],
      [sibling, waiting],
    ]) {
      assert.throws(
        () => nativeOperatorSelection({ action: 'retry', target }, records, [issue], 'operator'),
        /dispatch-target-ambiguous/,
      );
      assert.equal(
        nativeOperatorSelection(
          { action: 'retry', target, chat: sibling.threadId },
          records,
          [issue],
          'operator',
        ),
        sibling,
      );
    }
    for (const action of ['retire', 'reset', 'retry-denied'])
      assert.throws(
        () =>
          nativeOperatorSelection({ action, target }, [excluded[0]!, waiting], [issue], 'operator'),
        /dispatch-target-ambiguous/,
      );
  });
  it('should resolve the current task or an explicit resource without accepting binding overrides', () => {
    assert.equal(
      nativeOperatorSelection({ action: 'retire' }, [original], [issue], 'original-chat'),
      original,
    );
    assert.equal(
      nativeOperatorSelection({ action: 'retire', target }, [original], [issue], 'operator'),
      original,
    );
    for (const action of ['recover', 'retire', 'retry', 'reset', 'retry-denied']) {
      const schema = ['reset', 'retry-denied'].includes(action)
        ? codexRecoveryModelSchema
        : dispatchModelParameters;
      const input = {
        action,
        target,
        ...(action === 'recover' ? { pullRequest: 'https://github.com/owner/repo/pull/4' } : {}),
      };
      assert.equal(Value.Check(schema, input), true);
      for (const field of ['id', 'digest', 'apply', 'approvedCallId', 'threadId'])
        assert.equal(Value.Check(schema, { ...input, [field]: 'original' }), false);
    }
    assert.throws(
      () => nativeOperatorSelection({ action: 'retire' }, [original], [issue], 'unrelated'),
      /unavailable/,
    );
  });
  it('should reconcile only the original recovery from the same native input', () => {
    const invocation = { turnId: 'turn', inputId: 'input' };
    const previous = {
      ...original,
      supersededBy: 'successor',
      recovery: { by: 'operator', ...invocation, at: 1, digest: 'internal' },
    };
    const successor = {
      ...original,
      id: 'successor',
      predecessorId: original.id,
      threadId: 'new-chat',
    };
    const records = [previous, successor];
    assert.equal(
      nativeOperatorSelection(
        { action: 'recover', target },
        records,
        [issue],
        'operator',
        invocation,
      ),
      previous,
    );
    assert.throws(
      () =>
        nativeOperatorSelection({ action: 'recover', target }, records, [issue], 'operator', {
          ...invocation,
          inputId: 'other',
        }),
      /ambiguous/,
    );
    assert.equal(
      nativeOperatorSelection(
        { action: 'recover', target, chat: 'original-chat' },
        records,
        [issue],
        'operator',
      ),
      previous,
    );
  });
});
