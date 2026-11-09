import assert from 'node:assert/strict';

import codexReply from '../agent/codex-reply.ts';
import openClawReply from '../agent/openclaw-reply.ts';
import { parseReplyRequest } from '../tools/dispatch/reply-schema.ts';

describe('tools/dispatch/reply-schema', () => {
  it('should accept authored content without model-supplied runtime metadata', () => {
    const request = { action: 'reply', operation: 'compose', privateText: 'The change is ready.' };
    assert.deepEqual(parseReplyRequest(request), request);
    assert.deepEqual(parseReplyRequest({ ...request, outcome: 'Verified the change.' }), {
      ...request,
      outcome: 'Verified the change.',
    });
  });

  it('should identify the malformed outcome in both adapters before runtime access', async () => {
    const request = {
      action: 'reply',
      operation: 'compose',
      privateText: 'The change is ready.',
      outcome: { secret: 'private-value' },
    };
    for (const run of [
      () => codexReply('/unused-plugin-data', request, {}),
      () => openClawReply({ action: request } as Parameters<typeof openClawReply>[0]),
    ])
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal('code' in error && error.code, 'reply-request-invalid');
        assert.match(error.message, /request\.outcome must be string/);
        assert.match(error.message, /optional authored text/);
        assert.doesNotMatch(error.message, /private-value|secret/);
        return true;
      });
  });

  it('should reject runtime overrides without echoing unknown names or values', () => {
    for (const key of ['id', 'eventId', 'digest', 'receipt', 'private-unknown'])
      assert.throws(
        () => parseReplyRequest({ action: 'reply', operation: 'compose', [key]: 'private-value' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /unsupported fields/);
          assert.doesNotMatch(error.message, /private-/);
          return true;
        },
      );
  });
});
