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
