import assert from 'node:assert/strict';

import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import observeUnavailable from '../agent/openclaw-retirement-unavailable.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

function fixture() {
  const record = {
    sourceThreadId: 'coordinator',
    threadId: 'agent:owner:issue:one',
    worktree: '/managed/issue',
    request: { key: 'agent:owner:issue:one', agentId: 'owner', cwd: '/managed/issue' },
    sessionCreation: { attempted: true, sessionId: 'child' },
  } as OpenClawDispatchRecord;
  const calls: string[] = [];
  const request: DispatchRequest = async (method) => {
    calls.push(method);
    assert.equal(method, 'sessions.describe');
    return { session: null };
  };
  return {
    record,
    calls,
    input: {
      record,
      request,
      agentId: 'owner',
      owner: 'coordinator',
      code: 'dispatch-session-response-invalid-sessions-describe-session-null',
    },
  };
}

describe('agent/openclaw-retirement-unavailable', () => {
  it('should distinguish a null lookup from an explicit access denial without mutation', async () => {
    const f = fixture();
    const before = structuredClone(f.record);
    assert.equal(await observeUnavailable(f.input), 'not-found');
    assert.equal(
      await observeUnavailable({
        ...f.input,
        code: 'session-dispatch-describe-forbidden',
        request: async () => {
          throw new Error('session-dispatch-describe-forbidden');
        },
      }),
      'access-denied',
    );
    assert.deepEqual(f.record, before);
    assert.deepEqual(f.calls, ['sessions.describe']);
  });
  it('should identify a legacy attempt with no child identity without inventing one', async () => {
    const f = fixture();
    f.record.request = {
      runtime: 'subagent',
      cwd: f.record.worktree,
    } as OpenClawDispatchRecord['request'];
    f.record.creationCall = { sessionId: 'parent', runId: 'run', toolCallId: 'create' };
    delete f.record.threadId;
    delete f.record.sessionCreation;
    assert.equal(
      await observeUnavailable({ ...f.input, code: 'retirement-session-identity-unresolved' }),
      'identity-unresolved',
    );
    assert.deepEqual(f.calls, []);
    assert.equal(f.record.native, undefined);
  });
  it('should not infer loss from timeouts, malformed responses, or a visible replacement', async () => {
    for (const response of [undefined, null, [], {}, 'access-denied', { session: {} }]) {
      const f = fixture();
      assert.equal(
        await observeUnavailable({ ...f.input, request: async () => response }),
        undefined,
      );
    }
    const f = fixture();
    assert.equal(
      await observeUnavailable({
        ...f.input,
        code: 'session-dispatch-describe-timeout-unverified',
      }),
      undefined,
    );
    assert.deepEqual(f.calls, []);
    await assert.rejects(
      observeUnavailable({
        ...f.input,
        request: async () => {
          throw new Error('timeout');
        },
      }),
      /timeout/,
    );
  });
  it('should preserve source, agent, workspace, and coordinator custody', async () => {
    for (const change of [
      (r: OpenClawDispatchRecord) => {
        r.sourceThreadId = 'different';
      },
      (r: OpenClawDispatchRecord) => {
        r.threadId = 'different';
      },
      (r: OpenClawDispatchRecord) => {
        r.worktree = '/different';
      },
      (r: OpenClawDispatchRecord) => {
        if (r.request && 'key' in r.request) r.request.agentId = 'different';
      },
      (r: OpenClawDispatchRecord) => {
        if (r.request && 'key' in r.request) {
          r.threadId = 'coordinator';
          r.request.key = 'coordinator';
        }
      },
    ]) {
      const f = fixture();
      change(f.record);
      assert.equal(await observeUnavailable(f.input), undefined);
      assert.deepEqual(f.calls, []);
    }
  });
});
