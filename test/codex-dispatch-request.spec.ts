import assert from 'node:assert/strict';
import validateDispatchRequest from '../agent/codex-dispatch-request.ts';
import { Value } from 'typebox/value';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import { launchRequestSchema } from '../tools/dispatch/launch-schema.ts';

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
  it('should accept readable bounded dispatch titles across runtime request schemas', () => {
    const id = 'a'.repeat(64);
    const digest = 'b'.repeat(64);
    const titles = ['Upgrade OpenClaw to 2026.10.6', "Fix user's issue: café 東京", 'x'.repeat(80)];
    for (const title of titles) {
      const prepare = {
        id,
        digest,
        assessment: { complexity: 'low', reason: 'Localized validation change.' },
        title,
      };
      validateDispatchRequest('prepare', prepare);
      assert.ok(Value.Check(dispatchParameters, { action: 'prepare', ...prepare }));
      assert.ok(
        Value.Check(launchRequestSchema, {
          action: 'launch',
          target: 'https://github.com/owner/repo/issues/1',
          operation: 'prepare',
          title,
        }),
      );
    }
  });
  it('should reject blank, control-character, and overlong dispatch titles', () => {
    const id = 'a'.repeat(64);
    const digest = 'b'.repeat(64);
    for (const title of [' ', '\t\n', 'bad\u0001title', 'x'.repeat(81)]) {
      const prepare = {
        id,
        digest,
        assessment: { complexity: 'low', reason: 'Localized validation change.' },
        title,
      };
      assert.throws(() => validateDispatchRequest('prepare', prepare), /dispatch-request-invalid/);
      assert.equal(Value.Check(dispatchParameters, { action: 'prepare', ...prepare }), false);
      assert.equal(
        Value.Check(launchRequestSchema, {
          action: 'launch',
          target: 'https://github.com/owner/repo/issues/1',
          operation: 'prepare',
          title,
        }),
        false,
      );
    }
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
