import assert from 'node:assert/strict';

import codexDirectInput from '../agent/codex-direct-input.ts';
import codexContinuationNative from '../agent/codex-continuation-native.ts';
import type { CodexThreadRequest } from '../agent/codex-thread-client.ts';

// Native shapes verified against the original #632 creation and source turn; no live writes.
describe('agent/codex-input-authority', () => {
  function fixture(tool = 'create_thread') {
    const prompt = 'Implement #632. Keep sync on hold. <scope>&';
    const envelope = (source: string, text: string) =>
      `<codex_delegation>\n  <source_thread_id>${source}</source_thread_id>\n  <input>${text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')}</input>\n</codex_delegation>`;
    const delegated = (source: string, id: string) => ({
      type: 'functionCallOutput',
      id,
      namespace: 'codex_app',
      name: tool,
      output: envelope(source, prompt),
    });
    const human = {
      type: 'userMessage',
      id: 'human',
      content: [{ type: 'text', text: 'Start #632 in a new chat; do not push or sync.' }],
    };
    const call = {
      type: 'mcpToolCall',
      id: 'send',
      server: 'codex_app',
      tool,
      status: 'completed',
      arguments: { threadId: 'child', hostId: 'local', prompt },
      result: {
        content: [
          { type: 'text', text: '{"clientThreadId":"client-new-thread:native","hostId":"local"}' },
        ],
      },
    };
    const histories: Record<string, Record<string, unknown>[]> = {
      child: [delegated('parent', 'received')],
      parent: [human, call],
    };
    const statuses: Record<string, Record<string, unknown>> = {};
    const request: CodexThreadRequest = async (method, params) => {
      const id = String(params.threadId);
      assert.ok(histories[id], `unexpected thread ${id}`);
      if (method === 'thread/read') return { thread: { id } };
      if (method === 'thread/turns/list') return { data: [{ id: `${id}-turn`, ...statuses[id] }] };
      assert.equal(method, 'thread/items/list');
      return { data: histories[id]!.map((item) => ({ turnId: `${id}-turn`, item })) };
    };
    return { request, histories, statuses, delegated, human, call, prompt };
  }
  for (const tool of ['create_thread', 'send_message_to_thread']) {
    it(`should preserve native ${tool} authority and restrictions without another human message`, async () => {
      const f = fixture(tool);
      const input = await codexDirectInput(f.request, 'child');
      assert.equal(input.inputId, 'received');
      const scope = JSON.parse(input.message!);
      assert.equal(scope.delegatedInput, f.prompt);
      assert.deepEqual(scope.sourceUserInputs, [f.human.content]);
      assert.match(scope.originatingInput, /do not push or sync/u);
      const retained = await codexContinuationNative(f.request)('intake', {
        id: 'a'.repeat(64),
        origin: 'input',
        sourceThreadId: 'child',
        sourceTurnId: 'child-turn',
        turnId: 'child-turn',
        inputId: input.inputId,
        beforeTurnId: 'child-turn',
        request: { threadId: 'child', prompt: f.prompt, model: 'model', thinking: 'high' },
      });
      assert.equal(retained.status, 'verified');
      f.call.status = 'inProgress';
      assert.equal((await codexDirectInput(f.request, 'child')).inputId, 'received');
    });
  }
  it('should follow nested native delegation to the human source and honor newer direct input', async () => {
    const f = fixture();
    f.histories.parent = [f.delegated('origin', 'parent-input'), f.call];
    f.histories.origin = [
      f.human,
      { ...f.call, id: 'origin-call', arguments: { ...f.call.arguments, threadId: 'parent' } },
    ];
    assert.match((await codexDirectInput(f.request, 'child')).message!, /do not push or sync/u);
    f.histories.child!.push({ ...f.human, id: 'new-direction' });
    assert.equal((await codexDirectInput(f.request, 'child')).inputId, 'new-direction');
  });
  it('should reject invented source authority, mismatched sends, cancellation and cycles', async () => {
    const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.histories.parent = [f.call];
      },
      (f) => {
        f.histories.parent = [{ ...f.human, type: 'agentMessage' }, f.call];
      },
      (f) => {
        f.call.arguments.prompt = 'different scope';
      },
      (f) => {
        f.call.arguments.threadId = 'another-child';
      },
      (f) => {
        f.call.arguments.hostId = 'another-host';
      },
      (f) => {
        f.call.status = 'failed';
      },
      (f) => {
        f.statuses.parent = { status: 'interrupted', completedAt: 42 };
      },
      (f) => {
        f.histories.parent = [f.delegated('child', 'cycle'), f.call];
      },
      (f) => {
        f.histories.child = [{ ...f.delegated('parent', 'received'), type: 'agentMessage' }];
      },
    ];
    for (const change of changes) {
      const f = fixture('send_message_to_thread');
      change(f);
      await assert.rejects(
        codexDirectInput(f.request, 'child'),
        /reply-native-user-input-required/u,
      );
    }
  });
  it('should preserve native denials in both the receiving and originating turns', async () => {
    for (const thread of ['child', 'parent']) {
      const f = fixture();
      f.histories[thread]!.push({ type: 'commandExecution', status: 'declined' });
      await assert.rejects(codexDirectInput(f.request, 'child'), /reply-native-approval-denied/u);
    }
  });
});
