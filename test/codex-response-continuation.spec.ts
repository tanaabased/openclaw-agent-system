import assert from 'node:assert/strict';

import continueCodexResponse from '../agent/codex-response-continuation.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { CodexWorkContext } from '../agent/codex-continuation-context.ts';

describe('agent/codex-response-continuation', () => {
  for (const revision of [false, true])
    it(`should retain an unfinished summary without waking completed work with revision ${revision}`, async () => {
      const done = { outcome: 'done', summary: 'Done.', fullResult: 'Verified work.' };
      const record = {
        id: 'issue',
        threadId: 'chat',
        resultTurnId: 'assessment',
        result: { outcome: 'plan-ready', plan: 'Historical plan.' },
        assessmentRevision: 1,
        continuation: {
          phase: 'running',
          ...(revision ? { resultHistory: [{ result: done }] } : { result: done }),
        },
        delivery: { reconciled: true, pullRequest: { pullRequestNumber: 7 } },
      } as DispatchRecord;
      const before = structuredClone(record);
      const context = {
        native: { find: async () => assert.fail('completed work must not prepare a summary turn') },
        save: async () => assert.fail('retain the unfinished summary unchanged'),
      } as unknown as CodexWorkContext;
      assert.equal(await continueCodexResponse(record, context), undefined);
      assert.deepEqual(record, before);
    });
});
