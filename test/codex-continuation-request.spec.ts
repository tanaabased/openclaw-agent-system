import assert from 'node:assert/strict';
import runCodexContinuation from '../agent/tasks/implementation/codex-continuation.ts';

describe('agent/codex continuation request', () => {
  it('should reject incomplete continuation requests before accessing workflow state', async () => {
    for (const action of [
      'context',
      'reconcile',
      'result',
      'delivery',
      'cancel',
      'retry',
      'retry-denied',
    ])
      await assert.rejects(
        runCodexContinuation('/unused-plugin-data', { action }),
        /continuation-request-invalid/,
      );
    for (const input of [
      { action: 'context', id: 'task', decision: { mode: 'work' } },
      { action: 'context', id: 'task', unknown: true },
      { action: 'result', id: 'task', material: { path: [], digest: 'a'.repeat(64), offset: 0 } },
    ])
      await assert.rejects(
        runCodexContinuation('/unused-plugin-data', input),
        /continuation-request-invalid/,
      );
  });
});
