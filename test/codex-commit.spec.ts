import assert from 'node:assert/strict';

import codexCommit from '../agent/codex-commit.ts';
import type { DispatchRecord, DispatchState } from '../agent/codex-dispatch-state.ts';
import mergeStateSnapshot from '../core/merge-state-snapshot.ts';

function record(id: string): DispatchRecord {
  return {
    id,
    intakeId: id,
    issueKey: id,
    sourceThreadId: 'intake',
    phase: 'routing',
    createdAt: 1,
    manifestDigest: 'manifest',
  };
}
function state(): DispatchState {
  return {
    version: 1,
    scope: 'scope',
    resetGeneration: 'initial',
    records: [record('first'), record('second')],
  };
}

describe('agent/codex-commit', () => {
  it('should permit independent records but reject competing changes to the effect owner', () => {
    const before = state();
    const proposed = structuredClone(before);
    const current = structuredClone(before);
    proposed.records[0]!.issueBranch = { attemptId: 'first', name: 'owned', phase: 'creating' };
    current.records[1]!.context = 'unrelated progress';
    const commit = codexCommit(1);
    assert.doesNotThrow(() => commit.reconcile(before, proposed, current));
    current.records[0]!.issueBranch = structuredClone(proposed.records[0]!.issueBranch);
    assert.throws(() => commit.reconcile(before, proposed, current), {
      code: 'private-state-snapshot-conflict',
    });
  });

  it('should reject stale owner evidence even at an otherwise unchanged checkpoint', () => {
    const before = state();
    const current = structuredClone(before);
    current.records[0]!.context = 'new source evidence';
    assert.throws(() => codexCommit(1, 'first').reconcile(before, before, current), {
      code: 'private-state-snapshot-conflict',
    });
    assert.doesNotThrow(() => codexCommit(1, 'second').reconcile(before, before, current));
  });

  for (const operation of ['delivery', 'continuation'] as const)
    it(`should merge ${operation} observations while protecting authority and effect ownership`, () => {
      const before = state();
      const proposed = structuredClone(before);
      proposed.records[0]!.context = 'task progress';
      const current = structuredClone(before);
      current.records[0]!.capacityObservation = { at: 2, code: 'dispatch-capacity-native-active' };
      current.records[0]!.nativeInactive = false;
      current.records[0]!.lifecycleCheckedAt = 2;
      current.records[0]!.intakeReportedAt = 2;
      current.continuationRun = { id: 'new occurrence', actions: 0 };
      const commit = codexCommit(1, 'first', operation);
      assert.doesNotThrow(() => commit.reconcile(before, proposed, current));
      const merged = mergeStateSnapshot(before, proposed, current) as DispatchState;
      assert.deepEqual(merged.records[0], { ...current.records[0], context: 'task progress' });
      assert.deepEqual(merged.continuationRun, current.continuationRun);
      for (const change of [
        { context: 'changed source' },
        { retired: { at: 2, by: 'operator' } },
        { handoff: { at: 2, by: 'operator', turnId: 'new turn' } },
        { issueBranch: { attemptId: 'first', name: 'other', phase: 'ready' as const } },
      ]) {
        const conflicting = structuredClone(current);
        Object.assign(conflicting.records[0]!, change);
        assert.throws(() => commit.reconcile(before, proposed, conflicting), {
          code: 'private-state-snapshot-conflict',
          snapshotConflict: 'owner',
        });
      }
    });

  it('should reject stale occurrence counters instead of collapsing equal increments', () => {
    const before = state();
    before.continuationRun = { id: 'occurrence', actions: 0 };
    const proposed = structuredClone(before);
    const current = structuredClone(before);
    proposed.continuationRun!.actions++;
    current.continuationRun!.actions++;
    assert.throws(() => codexCommit().reconcile(before, proposed, current), {
      code: 'private-state-snapshot-conflict',
    });
    current.continuationRun = { id: 'successor', actions: 0 };
    assert.throws(() => codexCommit().reconcile(before, proposed, current), {
      code: 'private-state-snapshot-conflict',
    });
  });

  it('should merge task-local continuation with unrelated counters but retain owner conflicts', () => {
    const before = state();
    const proposed = structuredClone(before);
    proposed.records[0]!.context = 'task progress';
    const current = structuredClone(before);
    current.continuationRun = { id: 'other occurrence', actions: 1 };
    const commit = codexCommit(1, 'first', 'continuation');
    assert.doesNotThrow(() => commit.reconcile(before, proposed, current));
    assert.throws(() => codexCommit(1, 'first').reconcile(before, proposed, current), {
      code: 'private-state-snapshot-conflict',
      snapshotConflict: 'occurrence',
    });
    current.records[0]!.retired = { at: 2, by: 'operator' };
    assert.throws(() => commit.reconcile(before, proposed, current), {
      code: 'private-state-snapshot-conflict',
      snapshotConflict: 'owner',
    });
  });

  for (const operation of ['delivery', 'continuation'] as const)
    it(`should reject competing counter writes even for ${operation}`, () => {
      const before = state();
      before.continuationRun = { id: 'occurrence', actions: 0 };
      const proposed = structuredClone(before);
      proposed.continuationRun!.actions++;
      const current = structuredClone(proposed);
      assert.throws(() => codexCommit(1, 'first', operation).reconcile(before, proposed, current), {
        code: 'private-state-snapshot-conflict',
        snapshotConflict: 'occurrence',
      });
    });

  it('should reject a fresh branch reservation owned by another issue including retired custody', () => {
    const before = state();
    const project = {
      id: 'project',
      path: '/project',
      commonDir: '/repo',
      ref: 'main',
      commit: 'a'.repeat(40),
    };
    for (const entry of before.records) entry.project = project;
    before.records[1]!.issueBranch = { attemptId: 'second', name: 'owned', phase: 'ready' };
    before.records[1]!.retired = { at: 1, by: 'operator' };
    const proposed = structuredClone(before);
    proposed.records[0]!.issueBranch = { attemptId: 'first', name: 'owned', phase: 'planned' };
    assert.throws(() => codexCommit().validate(before, proposed), /codex-branch-owner-mismatch/);
  });

  it('should enforce fresh capacity without blocking progress on an already reserved issue', () => {
    const before = state();
    for (const entry of before.records) {
      entry.request = {
        title: 'assess',
        prompt: 'assess',
        model: 'model',
        thinking: 'high',
        target: {
          type: 'project',
          projectId: 'project',
          environment: { type: 'worktree', startingState: { type: 'branch', branchName: 'main' } },
        },
      };
    }
    const request = before.records[1]!.request;
    delete before.records[1]!.request;
    before.records[0]!.phase = 'creating';
    const proposed = structuredClone(before);
    proposed.records[1]!.request = request;
    proposed.records[1]!.phase = 'creating';
    assert.throws(() => codexCommit(1).validate(before, proposed), /dispatch-at-capacity/);
    assert.doesNotThrow(() => codexCommit(2).validate(before, proposed));
    assert.doesNotThrow(() => codexCommit(1).validate(proposed, structuredClone(proposed)));
  });
});
