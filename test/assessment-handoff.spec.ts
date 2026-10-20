import assert from 'node:assert/strict';
import assessmentHandoff from '../agent/assessment-handoff.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';

const ready: SharedDispatchRecord = {
  id: 'a'.repeat(64),
  intakeId: 'b'.repeat(64),
  issueKey: 'c'.repeat(64),
  sourceThreadId: 'coordinator',
  phase: 'complete',
  createdAt: 1,
  manifestDigest: 'manifest',
  result: {
    version: 1,
    outcome: 'plan-ready',
    summary: 'Ready.',
    assessment: 'Bounded change.',
    plan: 'Implement and test.',
    evidence: [],
    progress: { completed: [], remaining: [] },
  },
};

describe('agent/assessment-handoff', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should select direct work without granting the stage before ${runtime} context`, () => {
      const record = structuredClone(ready);
      assert.equal(assessmentHandoff(record, 'work', runtime).next, 'implementation');
      assert.equal(record.progression, undefined);
    });
    it(`should retain plan clarification and lifecycle holds for ${runtime}`, () => {
      assert.equal(assessmentHandoff(ready, 'plan', runtime).next, 'planning');
      assert.equal(assessmentHandoff(ready, 'auto', runtime).next, 'planning');
      const questions = {
        ...ready,
        result: {
          ...ready.result!,
          outcome: 'clarification-needed' as const,
          assessment: 'A requirement is missing.',
          questions: ['Which behavior?'],
        },
      };
      assert.equal(assessmentHandoff(questions, 'work', runtime).next, 'planning');
      assert.equal(
        assessmentHandoff({ ...ready, reset: { at: 1, by: 'operator' } }, 'work', runtime).next,
        'planning',
      );
    });
    it(`should use the recorded auto decision for ${runtime}`, () => {
      for (const mode of ['plan', 'work'] as const) {
        const record = {
          ...ready,
          result: { ...ready.result!, decision: { mode, reasons: ['Assessed.'] } },
        };
        assert.equal(
          assessmentHandoff(record, 'auto', runtime).next,
          mode === 'work' ? 'implementation' : 'planning',
        );
      }
    });
  }
});
