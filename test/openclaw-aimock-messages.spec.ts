import assert from 'node:assert/strict';

import type { ChatCompletionRequest } from '@copilotkit/aimock';

import currentMessages from '../scripts/aimock-messages.ts';

describe('scripts/aimock-messages', () => {
  it('should retain runtime context and tool results inside the latest real user turn', () => {
    const request: ChatCompletionRequest = {
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'previous request' },
        { role: 'tool', tool_call_id: 'old', content: 'old result' },
        { role: 'user', content: 'current request' },
        {
          role: 'user',
          content: [{ type: 'text', text: '  OpenClaw runtime context:\ninternal details' }],
        },
        { role: 'tool', tool_call_id: 'current', content: 'current result' },
        { role: 'user', content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nmore context' },
      ],
    };
    const original = structuredClone(request);
    assert.deepEqual(currentMessages(request), request.messages.slice(2));
    assert.deepEqual(request, original);
    request.messages.push({ role: 'user', content: 'next request' });
    assert.deepEqual(currentMessages(request), request.messages.slice(-1));
  });

  it('should not discard ordinary user text mentioning a runtime context label', () => {
    const request: ChatCompletionRequest = {
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'previous request' },
        { role: 'user', content: 'Explain the OpenClaw runtime context: label.' },
      ],
    };
    assert.deepEqual(currentMessages(request), request.messages.slice(-1));
  });

  it('should preserve a context-only request without inventing a user boundary', () => {
    const request: ChatCompletionRequest = {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'system context' },
        { role: 'user', content: 'OpenClaw runtime context:\ninternal details' },
      ],
    };
    assert.deepEqual(currentMessages(request), request.messages);
    assert.deepEqual(currentMessages({ model: 'gpt-5.5', messages: [] }), []);
  });
});
