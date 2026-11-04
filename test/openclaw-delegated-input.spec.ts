import assert from 'node:assert/strict';

import { delegatedOperatorInput, operatorInputEvent } from '../agent/openclaw-session-input.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

describe('agent/openclaw-delegated-input', () => {
  function fixture() {
    const message = 'Implement #632. Keep sync on hold.';
    const user = (runId: string, content: string, senderIsOwner: boolean) => ({
      role: 'user',
      content,
      __openclaw: { id: `${runId}-input`, runId, idempotencyKey: `${runId}:user`, senderIsOwner },
    });
    const child = {
      timestamp: 20,
      ...user('child-run', message, false),
      role: 'assistant', // native display projection retains the user input identity and provenance
      provenance: {
        kind: 'inter_session',
        sourceTool: 'sessions_send',
        sourceSessionKey: 'parent',
      },
    };
    const parent = user('parent-run', 'Start #632 in the other chat. Do not push or sync.', true);
    const call = {
      timestamp: 10,
      role: 'assistant',
      __openclaw: { id: 'call-event', runId: 'parent-run' },
      content: [
        {
          type: 'toolCall',
          name: 'sessions_send',
          id: 'send',
          arguments: { sessionKey: 'child', message },
        },
      ],
    };
    const result = {
      role: 'toolResult',
      __openclaw: { id: 'result-event', runId: 'parent-run' },
      toolName: 'sessions_send',
      toolCallId: 'send',
      content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', runId: 'child-run' }) }],
    };
    const histories: Record<string, Record<string, unknown>[]> = {
      child: [child],
      parent: [parent, call, result],
    };
    const exact = new Map<string, Record<string, unknown>>();
    let cancelled = false;
    let denied = false;
    const request: DispatchRequest = async (method, params) => {
      if (method === 'agent.wait')
        return {
          runId: params.runId,
          status: denied ? 'error' : 'timeout',
          ...(denied ? { code: 'approval-denied' } : {}),
        };
      if (method === 'chat.message.get')
        return { ok: true, message: exact.get(String(params.messageId)) };
      assert.equal(method, 'chat.history');
      const key = String(params.sessionKey);
      const all = histories[key]!;
      assert.ok(all);
      const messages = params.messageId
        ? all.filter((item) => (item.__openclaw as { id?: string })?.id === params.messageId)
        : all;
      return {
        sessionId: `${key}-session`,
        messages,
        ...(params.inputRunIds
          ? {
              inputReceipts: [
                {
                  runId: `${key}-run`,
                  state: 'consumed',
                  consumedByEventId: `${key}-run-input`,
                  cancelled,
                },
              ],
            }
          : {}),
      };
    };
    const input = {
      request,
      sessionKey: 'child',
      sessionId: 'child-session',
      runId: 'child-run',
      retained: [],
      senderIsOwner: false,
    };
    return {
      input,
      histories,
      exact,
      child,
      parent,
      call,
      result,
      cancel() {
        cancelled = true;
      },
      deny() {
        denied = true;
      },
    };
  }
  it('should verify a native send from owner input without pretending the destination sender is human', async () => {
    const f = fixture();
    assert.equal((await delegatedOperatorInput(f.input))?.inputEventId, 'child-run-input');
    const source = await operatorInputEvent(f.input);
    assert.equal(source.inputEventId, 'child-run-input');
    const scope = JSON.parse(source.message);
    assert.equal(scope.originatingInput, f.parent.content);
    assert.equal(scope.delegatedInput, f.child.content);
    assert.equal(f.child.__openclaw.senderIsOwner, false);
  });
  it('should accept delivered input while the native sending tool is still waiting for the child', async () => {
    const f = fixture();
    f.histories.parent!.pop();
    assert.equal((await operatorInputEvent(f.input)).inputEventId, 'child-run-input');
  });
  it('should recover native truncated calls and projected send results before matching them', async () => {
    const f = fixture();
    // The completed result identifies the call even when display history has no details field.
    f.call.timestamp = 30;
    for (const entry of [f.call, f.result]) {
      f.exact.set(entry.__openclaw.id, entry);
      const index = f.histories.parent!.indexOf(entry);
      f.histories.parent![index] = {
        ...entry,
        content: [{ type: 'text', text: '[oversized]' }],
        __openclaw: { ...entry.__openclaw, truncated: true, reason: 'oversized' },
      };
    }
    assert.equal((await operatorInputEvent(f.input)).inputEventId, 'child-run-input');
  });
  it('should keep scheduled input on its existing path', async () => {
    const f = fixture();
    f.histories.child = [{ ...f.child, role: 'user', provenance: undefined }];
    assert.equal(await delegatedOperatorInput(f.input), undefined);
  });
  it('should not turn an ordinary source tool failure into revoked delegation', async () => {
    const f = fixture();
    f.histories.parent!.push({
      role: 'toolResult',
      toolName: 'exec',
      isError: true,
      details: { status: 'failed', exitCode: 1 },
      __openclaw: { runId: 'parent-run' },
    });
    assert.equal((await operatorInputEvent(f.input)).inputEventId, 'child-run-input');
  });
  it('should reject forged ancestry, non-owner sources, mismatched native sends and cycles', async () => {
    const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.parent.__openclaw.senderIsOwner = false;
      },
      (f) => {
        delete (f.parent.__openclaw as { senderIsOwner?: boolean }).senderIsOwner;
      },
      (f) => {
        f.child.provenance.sourceTool = 'subagent_announce';
      },
      (f) => {
        f.result.content[0]!.text = 'unavailable';
      },
      (f) => {
        f.result.toolCallId = 'different';
      },
      (f) => {
        f.result.content[0]!.text = JSON.stringify({ status: 'error', runId: 'child-run' });
      },
      (f) => {
        f.histories.parent = [f.parent, { ...f.call, role: 'user' }, f.result];
      },
      (f) => {
        f.histories.parent!.pop();
        f.call.content[0]!.arguments.message = 'different';
      },
      (f) => {
        f.histories.parent!.pop();
        f.call.timestamp = 30;
      },
      (f) => {
        f.histories.parent!.push({
          role: 'assistant',
          stopReason: 'aborted',
          __openclaw: { runId: 'parent-run' },
        });
      },
      (f) => {
        f.histories.parent = [
          { ...f.parent, provenance: { ...f.child.provenance, sourceSessionKey: 'child' } },
          f.call,
          f.result,
        ];
      },
    ];
    for (const change of changes) {
      const f = fixture();
      change(f);
      await assert.rejects(operatorInputEvent(f.input), /dispatch-operator-input-unverified/u);
    }
  });
  it('should preserve input cancellation and native parent denial', async () => {
    const f = fixture();
    f.cancel();
    await assert.rejects(operatorInputEvent(f.input), /dispatch-operator-input-unverified/u);
    const denied = fixture();
    denied.deny();
    await assert.rejects(operatorInputEvent(denied.input), /dispatch-operator-input-unverified/u);
    const review = fixture();
    review.histories.parent!.push({
      role: 'toolResult',
      toolName: 'exec',
      details: { status: 'failed', approvalReviewOutcome: 'denied' },
      __openclaw: { runId: 'parent-run' },
    });
    await assert.rejects(operatorInputEvent(review.input), /dispatch-operator-input-unverified/u);
  });
});
