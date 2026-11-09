import assert from 'node:assert/strict';
import invalidDeliveryRequest from '../tools/dispatch/delivery-request-error.ts';
import { assertDispatchModelRequest } from '../tools/dispatch/tool-schema.ts';
import { assertModelWorkflowInput } from '../agent/native-context-request.ts';

describe('delivery request diagnostics', () => {
  it('should give a valid minimal correction for openclaw linking without echoing input', () => {
    assert.throws(
      () =>
        assertDispatchModelRequest({ action: 'delivery', operation: 'link', url: 'private-url' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal('code' in error && error.code, 'delivery-request-invalid');
        const correction = error.message.match(/\{[^}]+\}/)?.[0];
        assert.ok(correction);
        assert.doesNotThrow(() => assertDispatchModelRequest(JSON.parse(correction)));
        assert.doesNotMatch(error.message, /private-url|title|body/);
        return true;
      },
    );
  });

  it('should keep runtime binding overrides invalid in both adapters', () => {
    for (const field of ['id', 'eventId', 'agentId', 'threadId', 'digest']) {
      assert.throws(() =>
        assertDispatchModelRequest({ action: 'delivery', operation: 'link', [field]: 'private' }),
      );
      assert.throws(
        () => assertModelWorkflowInput('delivery', { action: 'link', [field]: 'private' }),
        /native-context-binding-override/,
      );
    }
  });

  it('should distinguish authored publication content from retained-effect operations', () => {
    for (const runtime of ['codex', 'openclaw'] as const) {
      assert.match(
        invalidDeliveryRequest('publish', runtime).recovery.instruction,
        /title and body/,
      );
      assert.match(invalidDeliveryRequest('candidate', runtime).recovery.instruction, /publicText/);
      assert.match(
        invalidDeliveryRequest('announce', runtime).recovery.instruction,
        /retained announcement/,
      );
      assert.doesNotMatch(
        invalidDeliveryRequest('private-action', runtime).message,
        /private-action/,
      );
    }
  });
});
