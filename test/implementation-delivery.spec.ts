import { codexItemOccupied } from '../agent/codex-capacity.ts';
import { openClawItemOccupied } from '../agent/openclaw-capacity.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import assert from 'node:assert/strict';
import {
  hasDeliveredImplementation,
  retainImplementationDelivery,
  nativeIssueContext,
} from '../agent/implementation-delivery.ts';
import issueWorkflowProgress, {
  type IssueWorkflowState,
} from '../agent/issue-workflow-progress.ts';
import managedImplementationRoute from '../agent/managed-implementation-route.ts';
import type { AssessmentEntryDependencies } from '../agent/assessment-entry.ts';

describe('agent/implementation-delivery', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should permanently finish ${runtime} execution without discarding later publication receipts`, () => {
      const delivery = {
        reconciled: true,
        pushedHead: 'first',
        pullRequest: { pullRequestNumber: 7 },
      };
      const work = { result: { outcome: 'done' } };
      const record: IssueWorkflowState = {
        phase: 'complete',
        progression: { stage: 'implementation' },
        ...(runtime === 'codex'
          ? { continuation: { ...work, phase: 'delivery', head: 'first' }, delivery }
          : { work: { ...work, delivery } }),
      };
      assert.equal(hasDeliveredImplementation(record), true);
      retainImplementationDelivery(record);
      delivery.reconciled = false;
      delivery.pushedHead = 'second';
      if (record.continuation) {
        record.continuation.phase = 'blocked';
        record.continuation.code = 'continuation-send-unverified';
      } else record.work!.code = 'dispatch-turn-failed';
      assert.deepEqual(issueWorkflowProgress(record), { action: 'complete', status: 'delivered' });
      assert.equal(delivery.reconciled, false);
      assert.equal(delivery.pushedHead, 'second');
      record.retired = {};
      assert.equal(issueWorkflowProgress(record).action, 'stopped');
    });
  }

  it('should release historical execution reservations while retaining current native activity', () => {
    const codex = {
      phase: 'complete',
      implementationDelivered: true,
      request: {},
      handoff: { at: 1, by: 'owner', turnId: 'old' },
      autoDecision: { attempt: {} },
      continuation: { phase: 'blocked', code: 'continuation-send-unverified', attempt: {} },
      feedback: { events: [] },
    } as unknown as DispatchRecord;
    assert.equal(codexItemOccupied(codex), false);
    codex.capacityObservation = { at: 2, code: 'dispatch-capacity-native-active' };
    assert.equal(codexItemOccupied(codex), true);
    delete codex.capacityObservation;
    codex.feedback!.events.push({ phase: 'running' } as NonNullable<
      DispatchRecord['feedback']
    >['events'][number]);
    assert.equal(codexItemOccupied(codex), true);

    const openclaw = {
      phase: 'complete',
      implementationDelivered: true,
      request: {},
      work: { turn: { status: 'consumed' }, code: 'dispatch-turn-cancelled' },
      decisionTurn: { status: 'attempted' },
      feedback: { events: [], activity: { busy: false } },
    } as unknown as OpenClawDispatchRecord;
    assert.equal(openClawItemOccupied(openclaw), false);
    openclaw.feedback!.activity!.busy = true;
    assert.equal(openClawItemOccupied(openclaw), true);
  });

  it('should require finished work and verified linkage before ending execution', () => {
    const record: IssueWorkflowState = {
      phase: 'complete',
      progression: { stage: 'implementation' },
      continuation: { phase: 'running', head: 'current' },
      delivery: { reconciled: true, pushedHead: 'draft', pullRequest: { pullRequestNumber: 7 } },
    };
    retainImplementationDelivery(record);
    assert.equal(record.implementationDelivered, undefined);
    record.continuation!.result = { outcome: 'done' };
    assert.equal(hasDeliveredImplementation(record), false);
    record.delivery!.pushedHead = 'current';
    assert.equal(hasDeliveredImplementation(record), true);
  });

  it('should treat a legacy reopened round as history after its original pr was delivered', () => {
    const record: IssueWorkflowState = {
      phase: 'complete',
      continuation: {
        phase: 'blocked',
        head: 'later-edit',
        code: 'continuation-send-unverified',
        resultHistory: [{ result: { outcome: 'done' } }],
      },
      delivery: { reconciled: true, pushedHead: 'original', pullRequest: { pullRequestNumber: 7 } },
    };
    assert.deepEqual(issueWorkflowProgress(record), { action: 'complete', status: 'delivered' });
    assert.equal(record.continuation!.code, 'continuation-send-unverified');
  });

  it('should return native facts without routing a delivered task into an implementation owner', async () => {
    const nativeContext = nativeIssueContext({
      id: 'issue',
      phase: 'complete',
      worktree: '/tmp',
      work: { delivery: { binding: { branch: 'retained-branch' } } },
    });
    assert.equal(nativeContext.branch, 'retained-branch');
    const owner = {
      owner: { id: 'issue' },
      path: '/tmp',
      nativeContext,
    } as Awaited<ReturnType<AssessmentEntryDependencies['managed']>>;
    const result = await managedImplementationRoute({
      action: {
        action: 'implementation',
        operation: 'context',
        target: 'https://github.com/owner/repo/issues/7',
      },
      managed: async () => owner,
      route: async () => assert.fail('continuation must not own delivered work'),
    });
    assert.deepEqual(result?.result, nativeContext);
    assert.equal('resultContract' in result!.result, false);
  });
});
