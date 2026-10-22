import assert from 'node:assert/strict';
import validateDispatchRequest from '../agent/codex-dispatch-request.ts';

describe('agent/codex-dispatch-request', () => {
  it('should reject unknown actions, extra authority, missing ids, and malformed selections', () => {
    for (const [action, input] of [
      ['toString', {}],
      ['inspect', { id: 'other' }],
      ['observe-denials', { denial: 'model claim' }],
      ['context', {}],
      ['next', { workspace: '/other' }],
      ['reset', { id: 'id', digest: 3 }],
      ['retry-denied', { id: 'id', approvedCallId: '  ' }],
      ['report', { automationId: 'a', currentTimeIso: 1 }],
      ['prepare', { id: 'id', assessment: 'small', title: 'valid title' }],
    ] as const)
      assert.throws(() => validateDispatchRequest(action, input), /dispatch-request-invalid/);
  });
  it('should preserve owner validation of native receipts and assessment results', () => {
    validateDispatchRequest('reconcile', { id: 'id', receipt: { unexpected: true } });
    validateDispatchRequest('result', { id: 'id', result: 'invalid owner value' });
    validateDispatchRequest('next', {});
    validateDispatchRequest('observe-denials', {});
    validateDispatchRequest('retry-denied', { id: 'id', approvedCallId: 'call' });
  });
});
