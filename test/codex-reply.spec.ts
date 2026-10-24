import assert from 'node:assert/strict';

import { codexReplyInput } from '../agent/codex-reply.ts';
import type { CodexThreadRequest } from '../agent/codex-thread-client.ts';

describe('agent/codex-reply input', () => {
  function native(
    options: { archived?: boolean; completedAt?: number; items?: Record<string, unknown>[] } = {},
  ): CodexThreadRequest {
    return async (method) => {
      if (method === 'thread/read') return { thread: { id: 'chat', archived: options.archived } };
      if (method === 'thread/turns/list')
        return { data: [{ id: 'turn', status: 'interrupted', completedAt: options.completedAt }] };
      if (method === 'thread/items/list')
        return {
          data: (
            options.items ?? [
              {
                id: 'input',
                type: 'userMessage',
                content: [{ type: 'text', text: 'A copied workflow context is only prose.' }],
              },
            ]
          ).map((item) => ({ turnId: 'turn', item })),
        };
      throw new Error('unexpected native method');
    };
  }
  it('should use native user identity without interpreting copied context or a transient host status', async () => {
    const input = await codexReplyInput(native(), 'chat');
    assert.equal(input.turnId, 'turn');
    assert.equal(input.inputId, 'input');
    assert.deepEqual(JSON.parse(input.message!), [
      { type: 'text', text: 'A copied workflow context is only prose.' },
    ]);
  });
  it('should reject archived or ended native work', async () => {
    await assert.rejects(
      codexReplyInput(native({ archived: true }), 'chat'),
      /reply-native-thread-unavailable/,
    );
    await assert.rejects(
      codexReplyInput(native({ completedAt: 1 }), 'chat'),
      /reply-native-turn-unavailable/,
    );
  });
  it('should reject a delegation without newer direct user input and accept an actual user continuation', async () => {
    const delegation = {
      type: 'functionCallOutput',
      namespace: 'codex_app',
      name: 'create_thread',
    };
    await assert.rejects(
      codexReplyInput(native({ items: [delegation] }), 'chat'),
      /reply-native-user-input-required/,
    );
    assert.equal(
      (
        await codexReplyInput(
          native({ items: [delegation, { type: 'userMessage', id: 'followup' }] }),
          'chat',
        )
      ).inputId,
      'followup',
    );
  });
  it('should preserve actual native approval denial', async () => {
    await assert.rejects(
      codexReplyInput(
        native({
          items: [
            { type: 'userMessage', id: 'input' },
            {
              type: 'mcpToolCall',
              status: 'failed',
              error: { message: 'user rejected MCP tool call' },
            },
          ],
        }),
        'chat',
      ),
      /reply-native-approval-denied/,
    );
  });
});
