import assert from 'node:assert/strict';
import continueCodexResponse from '../agent/codex-response-continuation.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { CodexWorkContext } from '../agent/codex-continuation-context.ts';

describe('agent/codex-response-continuation', () => {
  it('should leave delivered execution and unfinished summary receipts outside recovery', async () => {
    const record = {
      id: 'issue',
      phase: 'complete',
      threadId: 'chat',
      worktree: '/tmp',
      request: { prompt: 'Assess the issue.' },
      project: { id: 'project' },
      resultTurnId: 'assessment',
      assessmentRevision: 1,
      result: { outcome: 'plan-ready', plan: 'Plan.', fullAssessment: 'Complete assessment.' },
      continuation: {
        phase: 'complete',
        result: { outcome: 'done', summary: 'Done.', fullResult: 'Checked.' },
      },
      delivery: { reconciled: true, pullRequest: { pullRequestNumber: 7 } },
      summaryRecovery: { revision: 1, attempt: { id: 'old-send' } },
    } as DispatchRecord;
    const before = structuredClone(record);
    const context = new Proxy({} as CodexWorkContext, {
      get() {
        throw new Error('recovery-context-entered');
      },
    });
    assert.equal(await continueCodexResponse(record, context), undefined);
    assert.deepEqual(record, before);
    // Control: without delivered linkage this same record reaches recovery dependencies.
    record.delivery!.reconciled = false;
    await assert.rejects(continueCodexResponse(record, context), /recovery-context-entered/);
  });
});
