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
import managedImplementationRoute from '../agent/managed-implementation-route.ts';
import workflowStatus, { type IssueWorkflowState } from '../agent/workflow-status.ts';
import type { AssessmentEntryDependencies } from '../agent/assessment-entry.ts';

describe('agent/implementation-delivery', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should recognize legacy ${runtime} feedback-first delivery without merging its work into the initial result`, () => {
      const delivery = {
        reconciled: true,
        pushedHead: 'first',
        pullRequest: { pullRequestNumber: 7 },
      };
      const event = { phase: 'running', work: { head: 'first', result: { outcome: 'done' } } };
      const record = {
        phase: 'complete',
        result: { outcome: 'plan-ready' },
        progression: { stage: 'implementation' },
        feedback: { events: [event] },
        ...(runtime === 'codex' ? { delivery } : { work: { delivery } }),
      };
      assert.equal(workflowStatus(record), 'native-unobserved');
      assert.equal(hasDeliveredImplementation(record), true);
      delivery.pushedHead = 'unpublished';
      assert.equal(hasDeliveredImplementation(record), true);
      delivery.pushedHead = 'first';
      delivery.reconciled = false;
      assert.equal(hasDeliveredImplementation(record), false);
      delivery.reconciled = true;
      event.work.result.outcome = 'clarification-needed';
      assert.equal(hasDeliveredImplementation(record), true);
    });

    it(`should retain ${runtime} publication history without discarding later receipts`, () => {
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
      assert.equal(hasDeliveredImplementation(record), true);
      assert.equal(delivery.reconciled, false);
      assert.equal(delivery.pushedHead, 'second');
      record.retired = {};
      assert.equal(workflowStatus(record), 'obsolete');
    });
  }

  it('should release historical execution reservations while retaining current native activity', () => {
    const codex = {
      phase: 'complete',
      implementationDelivered: true,
      nativeInactive: true,
      request: {},
      handoff: { at: 1, by: 'owner', turnId: 'old' },
      autoDecision: { attempt: {} },
      continuation: { phase: 'blocked', code: 'continuation-send-unverified', attempt: {} },
      feedback: { events: [] },
    } as unknown as DispatchRecord;
    assert.equal(codexItemOccupied(codex), false);
    codex.nativeInactive = false;
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
      nativeInactive: true,
      request: {},
      sessionCreation: { verified: true },
      work: { turn: { status: 'completed' } },
      decisionTurn: { status: 'completed' },
      feedback: { events: [], activity: { busy: false } },
    } as unknown as OpenClawDispatchRecord;
    assert.equal(openClawItemOccupied(openclaw), false);
    openclaw.nativeInactive = false;
    openclaw.feedback!.activity!.busy = true;
    assert.equal(openClawItemOccupied(openclaw), true);
  });

  it('should recognize verified pr publication without a saved implementation result', () => {
    const record: IssueWorkflowState = {
      phase: 'assessing',
      delivery: {
        reconciled: true,
        pushedHead: 'published',
        pullRequest: { pullRequestNumber: 7 },
      },
    };
    assert.equal(hasDeliveredImplementation(record), true);
    retainImplementationDelivery(record);
    assert.equal(record.phase, 'assessing');
    assert.equal(record.result, undefined);
    assert.equal(record.progression, undefined);
    assert.equal(record.implementationDelivered, true);
  });

  it('should not treat an observed existing pr as a new publication', () => {
    const record: IssueWorkflowState = {
      phase: 'created',
      delivery: { adopted: {}, reconciled: true, pullRequest: { pullRequestNumber: 7 } },
    };
    assert.equal(hasDeliveredImplementation(record), false);
    record.delivery!.pushedHead = 'published';
    assert.equal(hasDeliveredImplementation(record), true);
  });

  it('should refresh native facts without routing a delivered task into an implementation owner', async () => {
    const previous = { outcome: 'done', summary: 'OLD-WORK', fullResult: 'OLD-PLAN' };
    const nativeContext = nativeIssueContext({
      id: 'issue',
      phase: 'complete',
      worktree: '/tmp',
      work: {
        result: previous,
        delivery: { binding: { branch: 'retained-branch' } },
      },
    });
    assert.equal(nativeContext.branch, 'retained-branch');
    assert.doesNotMatch(JSON.stringify(nativeContext), /OLD-WORK|OLD-PLAN/);
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
    assert.equal(result, undefined, 'context refresh belongs to the readonly collector');
    assert.equal('resultContract' in nativeContext, false);
  });
});
