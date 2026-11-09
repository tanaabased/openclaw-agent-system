import assert from 'node:assert/strict';
import reconcileCodexRequests from '../agent/codex-request-reconciliation.ts';
import type { CodexWorkContext } from '../agent/codex-continuation-context.ts';

describe('agent/codex-request-reconciliation', () => {
  it('should not generate work for idle chats, missing results, or unanswered questions', async () => {
    const records = [
      { id: 'plan', result: { outcome: 'plan-ready' } },
      { id: 'waiting', continuation: { phase: 'clarification-needed' } },
      { id: 'stopped', continuation: { phase: 'cancelled' } },
      { id: 'missing', continuation: { phase: 'running' } },
    ];
    const before = structuredClone(records);
    const result = await reconcileCodexRequests({
      records,
      input: { action: 'next' },
      continuationNative: async () => {
        throw new Error('no request exists');
      },
      save: async () => {
        throw new Error('no state change is needed');
      },
    } as unknown as CodexWorkContext);
    assert.deepEqual(result, { status: 'reconciled', outcomes: [] });
    assert.deepEqual(records, before);
  });

  it('should reconcile existing requests independently without preparing another send', async () => {
    const records = [
      { id: 'broken', sourceThreadId: 'coordinator', autoDecision: { attempt: { id: 'bad' } } },
      { id: 'other', sourceThreadId: 'coordinator', summaryRecovery: { attempt: { id: 'good' } } },
    ];
    const seen: string[] = [];
    const result = await reconcileCodexRequests({
      records,
      input: { action: 'next' },
      continuationNative: async (_source: string, attempt: { id: string }) => {
        seen.push(attempt.id);
        if (attempt.id === 'bad') throw new Error('native history unavailable');
        return { status: 'verified', turnId: 'ended-turn', ended: true };
      },
      save: async () => {},
    } as unknown as CodexWorkContext);
    assert.deepEqual(seen, ['bad', 'good']);
    assert.equal(result.outcomes.length, 2);
    assert.equal((records[1]!.summaryRecovery as { ended?: boolean }).ended, true);
    assert.ok(result.outcomes.every((outcome) => !('request' in outcome)));
  });
  it('should stop polling a completed legacy request without changing conversation permission', async () => {
    const record = {
      id: 'task',
      sourceThreadId: 'coordinator',
      continuation: {
        phase: 'cancelled',
        attempt: { id: 'old-request' },
      },
    };
    let reads = 0;
    const context = {
      records: [record],
      input: { action: 'next' },
      save: async () => {},
      continuationNative: async () => {
        reads++;
        return { status: 'verified', turnId: 'old-turn', ended: true };
      },
    } as unknown as CodexWorkContext;
    await reconcileCodexRequests(context);
    await reconcileCodexRequests(context);
    assert.equal(reads, 1);
    assert.equal(record.continuation.phase, 'cancelled');
    assert.deepEqual(record.continuation.attempt, {
      id: 'old-request',
      turnId: 'old-turn',
      ended: true,
    });
  });
});
