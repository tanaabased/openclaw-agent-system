import assert from 'node:assert/strict';
import type { AssessmentEntryDependencies } from '../agent/assessment-entry.ts';
import { codexItemOccupied } from '../agent/codex-capacity.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import { nativeIssueContext } from '../agent/native-issue-context.ts';
import managedImplementationRoute from '../agent/managed-implementation-route.ts';
import { openClawItemOccupied } from '../agent/openclaw-capacity.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';

describe('agent/native-issue-context', () => {
  it('should release historical execution reservations while retaining current native activity', () => {
    const codex = {
      nativeInactive: true,
      request: {},
      handoff: { at: 1, by: 'owner', turnId: 'old' },

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
      nativeInactive: true,
      request: {},
      sessionCreation: { verified: true },
      work: {},
      feedback: { events: [], activity: { busy: false } },
    } as unknown as OpenClawDispatchRecord;
    assert.equal(openClawItemOccupied(openclaw), false);
    openclaw.nativeInactive = false;
    openclaw.feedback!.activity!.busy = true;
    assert.equal(openClawItemOccupied(openclaw), true);
  });

  it('should retain an uncertain native effect despite an earlier idle observation', () => {
    const record = {
      request: {},
      nativeInactive: true,
      sessionCreation: { verified: true },
      feedback: { events: [], activity: { busy: true } },
      nativeTurns: [{ role: 'first', turn: { status: 'attempted' } }],
    } as unknown as OpenClawDispatchRecord;
    assert.equal(openClawItemOccupied(record), true);
    record.nativeTurns!.findLast(({ role }) => role === 'first')!.turn.status = 'completed';
    assert.equal(openClawItemOccupied(record), false);
    record.nativeInactive = false;
    record.feedback!.activity!.busy = false;
    assert.equal(openClawItemOccupied(record), true);
  });

  it('should refresh native facts without routing a delivered task into an implementation owner', async () => {
    const nativeContext = nativeIssueContext({
      id: 'issue',

      worktree: '/tmp',
      delivery: { binding: { branch: 'retained-branch' } },
      work: {},
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
