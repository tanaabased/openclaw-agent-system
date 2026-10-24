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
      ['reset', { id: 'a'.repeat(64), digest: 3 }],
      ['retry-denied', { id: 'a'.repeat(64), approvedCallId: '  ' }],
      ['report', { automationId: 'a', currentTimeIso: 1 }],
      ['prepare', { id: 'a'.repeat(64), assessment: 'small', title: 'valid title' }],
    ] as const)
      assert.throws(() => validateDispatchRequest(action, input), /dispatch-request-invalid/);
  });
  it('should preserve owner validation of native receipts and assessment results', () => {
    validateDispatchRequest('reconcile', { id: 'a'.repeat(64), receipt: { unexpected: true } });
    validateDispatchRequest('result', { id: 'a'.repeat(64), result: 'invalid owner value' });
    validateDispatchRequest('next', {});
    validateDispatchRequest('observe-denials', {});
    validateDispatchRequest('retry-denied', {
      id: 'a'.repeat(64),
      approvedCallId: 'call',
    });
  });
  it('should distinguish malformed receipt ids from other invalid requests', () => {
    for (const id of ['x'.repeat(100), 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)])
      assert.throws(
        () => validateDispatchRequest('context', { id }),
        /dispatch-receipt-id-invalid/,
      );
    validateDispatchRequest('context', { id: 'a'.repeat(64) });
  });
});
