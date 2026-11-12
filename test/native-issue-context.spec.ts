import assert from 'node:assert/strict';
import type { AssessmentEntryDependencies } from '../agent/tasks/assessment/assessment-entry.ts';
import { codexItemOccupied } from '../agent/codex-capacity.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import { nativeIssueContext } from '../agent/native-issue-context.ts';
import managedImplementationRoute from '../agent/tasks/implementation/managed-implementation-route.ts';
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
      feedback: { events: [] },
    } as unknown as OpenClawDispatchRecord;
    assert.equal(openClawItemOccupied(openclaw), false);
    openclaw.nativeInactive = false;
    assert.equal(openClawItemOccupied(openclaw), true);
  });

  it('should retain an uncertain native effect despite an earlier idle observation', () => {
    const record = {
      request: {},
      nativeInactive: true,
      sessionCreation: { verified: true },
      feedback: { events: [] },
      nativeTurns: [{ role: 'assessment', turn: { status: 'attempted' } }],
    } as unknown as OpenClawDispatchRecord;
    assert.equal(openClawItemOccupied(record), true);
    record.nativeTurns!.findLast(({ role }) => role === 'assessment')!.turn.status = 'completed';
    assert.equal(openClawItemOccupied(record), false);
    record.nativeInactive = false;
    assert.equal(openClawItemOccupied(record), true);
  });

  it('should refresh native context without invoking implementation', async () => {
    const nativeContext = nativeIssueContext({
      id: 'issue',

      worktree: '/tmp',
      delivery: { binding: { branch: 'retained-branch' } },
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
      route: async () => assert.fail('context refresh must not invoke implementation'),
    });
    assert.equal(result, undefined, 'context refresh belongs to the readonly collector');
    assert.equal('resultContract' in nativeContext, false);
  });
});
