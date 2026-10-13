import assert from 'node:assert/strict';

import codexContinuationNative from '../agent/codex-continuation-native.ts';
import type { CodexContinuationState } from '../agent/codex-continuation-state.ts';

// constructed protocol cases; the authorized desktop pilot owns live native evidence.
describe('agent/codex-continuation-native', () => {
  const attempt: NonNullable<CodexContinuationState['attempt']> = {
    id: 'a'.repeat(64),
    sourceTurnId: 'scan',
    beforeTurnId: 'assessment',
    request: {
      threadId: 'issue',
      prompt: 'Continue this issue.',
      model: 'model',
      thinking: 'high',
    },
  };
  function fixture(
    options: {
      call?: boolean;
      status?: string;
      duplicate?: boolean;
      prompt?: string;
      sourceTurn?: string;
      forged?: boolean;
    } = {},
  ) {
    const call = {
      type: options.forged ? 'agentMessage' : 'mcpToolCall',
      server: 'codex_app',
      tool: 'send_message_to_thread',
      arguments: attempt.request,
      status: options.status ?? 'completed',
    };
    const source = [
      {
        id: options.sourceTurn ?? 'scan',
        status: 'completed',
        items: options.call === false ? [] : [call],
      },
    ];
    const implementation = {
      id: 'implementation',
      status: 'inProgress',
      items: [
        {
          type: 'userMessage',
          content: [{ type: 'text', text: options.prompt ?? attempt.request.prompt }],
        },
      ],
    };
    const target = [
      { id: 'assessment', status: 'completed', items: [] },
      implementation,
      ...(options.duplicate ? [{ ...implementation, id: 'duplicate' }] : []),
    ];
    return codexContinuationNative(async (method, params) => {
      if (params.threadId === 'source') {
        assert.equal(method, 'thread/items/list');
        assert.equal(params.turnId, attempt.sourceTurnId);
      }
      const turns = params.threadId === 'source' ? source : target;
      return {
        data:
          method === 'thread/turns/list'
            ? turns
            : turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))),
        nextCursor: null,
      };
    });
  }
  it('should verify only the recorded source turn and its exact native target', async () => {
    assert.deepEqual(await fixture()('source', attempt), {
      status: 'verified',
      turnId: 'implementation',
      turnStatus: 'inProgress',
    });
  });
  it('should retain uncertainty when a send or target response is missing', async () => {
    for (const options of [
      { call: false },
      { prompt: 'Something else.' },
      { status: 'inProgress' },
    ])
      assert.deepEqual(await fixture(options)('source', attempt), { status: 'uncertain' });
  });
  it('should reject copied prose and duplicate or unrelated turns', async () => {
    assert.deepEqual(await fixture({ forged: true })('source', attempt), { status: 'uncertain' });
    await assert.rejects(fixture({ duplicate: true })('source', attempt), /turn-ambiguous/);
    await assert.rejects(
      fixture({ sourceTurn: 'old-scan' })('source', attempt),
      /source-unavailable/,
    );
  });
  it('should stop after native denial instead of treating failure as an unsubmitted request', async () => {
    assert.deepEqual(await fixture({ status: 'failed' })('source', attempt), {
      status: 'blocked',
      code: 'continuation-native-send-failed',
    });
  });
});
