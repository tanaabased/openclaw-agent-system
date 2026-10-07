import assert from 'node:assert/strict';

import {
  AutomationError,
  createAutomationGateway,
  listNativeAutomations,
  nativeAutomation,
  nativeAutomationRun,
  nativeAutomationHistory,
} from '../agent/automation-gateway.ts';
import { privateStateFileLockLostErrorCode } from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import { controlledFileLock } from './private-state-file-lock-fixture.ts';

const job = (id: string) => ({
  id,
  agentId: 'a',
  declarationKey: `owned:${id}`,
  enabled: false,
  configRevision: id,
  schedule: {},
  payload: {},
  state: {},
});
describe('agent/automation-gateway', () => {
  it('should stop session rpc before dispatch after lock loss without relabeling it as transport failure', async () => {
    const fixture = await controlledFileLock();
    let calls = 0;
    const request = createAutomationGateway(async () => {
      calls += 1;
      return {};
    });
    try {
      await assert.rejects(
        withPrivateStateLock(fixture.handle, async () => {
          fixture.compromise();
          for (const method of ['sessions.create', 'sessions.patch'] as const)
            await assert.rejects(request(method, {}), { code: privateStateFileLockLostErrorCode });
        }),
        { code: privateStateFileLockLostErrorCode },
      );
    } finally {
      await fixture.handle.release();
    }
    assert.equal(calls, 0);
  });

  it('should supply exact native operator transport options and contain provider failures', async () => {
    const calls: unknown[][] = [];
    const request = createAutomationGateway(async (...args: unknown[]) => {
      calls.push(args);
      return {};
    });
    for (const method of [
      'cron.list',
      'cron.get',
      'cron.status',
      'cron.runs',
      'cron.add',
      'cron.update',
      'cron.run',
      'sessions.resolve',
      'sessions.list',
      'sessions.create',
      'sessions.patch',
    ] as const) {
      await request(method, { id: 'fixture' });
      const readOnly = [
        'cron.list',
        'cron.get',
        'cron.status',
        'cron.runs',
        'sessions.resolve',
        'sessions.list',
      ].includes(method);
      assert.deepEqual(calls.at(-1), [
        method,
        { timeout: '10000' },
        { id: 'fixture' },
        {
          progress: false,
          scopes: [readOnly ? 'operator.read' : 'operator.admin'],
          ...(readOnly ? { sharedStateMode: 'read-only' } : {}),
        },
      ]);
    }
    await assert.rejects(
      createAutomationGateway(async () => {
        throw new Error('secret');
      })('cron.run', {}),
      (error: unknown) =>
        error instanceof AutomationError &&
        error.diagnostic?.method === 'cron.run' &&
        error.diagnostic.category === 'unknown' &&
        error.code === 'automation-gateway-failed' &&
        !error.message.includes('secret'),
    );
  });
  it('should read all pages including disabled jobs without mutation', async () => {
    const offsets: unknown[] = [];
    const result = await listNativeAutomations(async (method, params) => {
      assert.equal(method, 'cron.list');
      assert.equal(params.includeDisabled, true);
      assert.equal(params.includeDeliveryPreviews, false);
      offsets.push(params.offset);
      return params.offset === 0
        ? { jobs: Array.from({ length: 200 }, (_, n) => job(String(n))), hasMore: true }
        : { jobs: [job('last')], hasMore: false };
    });
    assert.equal(result.length, 201);
    assert.deepEqual(offsets, [0, 200]);
  });
  it('should reject malformed partial duplicate and unversioned native snapshots', async () => {
    await assert.rejects(
      listNativeAutomations(async () => ({ jobs: [] })),
      /response-invalid/u,
    );
    await assert.rejects(
      listNativeAutomations(async () => ({ jobs: [job('one')], hasMore: true })),
      /snapshot-diverged/u,
    );
    await assert.rejects(
      listNativeAutomations(async () => ({ jobs: [job('one'), job('one')], hasMore: false })),
      /snapshot-diverged/u,
    );
    assert.throws(
      () => nativeAutomation({ ...job('one'), configRevision: undefined }),
      /response-invalid/u,
    );
  });
});

// constructed negatives; these are not live captures.
describe('agent/automation-result-parsers', () => {
  it('should distinguish queued admission from skips and reject incomplete responses', () => {
    assert.deepEqual(nativeAutomationRun({ ok: true, enqueued: true, runId: 'r' }), {
      status: 'queued',
      runId: 'r',
    });
    assert.deepEqual(nativeAutomationRun({ ok: true, ran: false, reason: 'already-running' }), {
      status: 'skipped',
      reason: 'already-running',
    });
    for (const value of [
      null,
      [],
      {},
      { ok: true },
      { ok: true, enqueued: true },
      { ok: false },
      { ok: true, ran: true },
      { ok: true, ran: false, reason: 'secret text' },
    ])
      assert.throws(() => nativeAutomationRun(value), /response-invalid/u);
  });
  it('should preserve paging and separate execution from delivery while excluding raw diagnostics', () => {
    const page = {
      entries: [
        {
          ts: 42,
          action: 'finished',
          jobId: 'native',
          runId: 'r',
          status: 'error',
          deliveryStatus: 'not-requested',
          error: 'secret',
        },
      ],
      total: 2,
      offset: 0,
      limit: 1,
      hasMore: true,
      nextOffset: 1,
    };
    const result = nativeAutomationHistory(page, 'native', { limit: 1, offset: 0 });
    assert.equal(result.hasMore, true);
    assert.equal(result.nextOffset, 1);
    assert.deepEqual(result.entries[0], {
      ts: 42,
      runId: 'r',
      execution: 'error',
      delivery: 'not-requested',
    });
    assert.equal(
      nativeAutomationHistory(
        { entries: [], total: 2, offset: 2, limit: 1, hasMore: false, nextOffset: null },
        'native',
        { limit: 1, offset: 99 },
      ).offset,
      2,
    );
    for (const value of [
      null,
      [],
      { ...page, entries: [] },
      { ...page, nextOffset: 7 },
      { ...page, hasMore: false },
      { ...page, entries: [{ ...page.entries[0], jobId: 'other' }] },
      { ...page, entries: [{ ...page.entries[0], status: 'invalid' }] },
    ])
      assert.throws(
        () => nativeAutomationHistory(value, 'native', { limit: 1, offset: 0 }),
        /response-invalid/u,
      );
    assert.throws(
      () => nativeAutomationHistory(page, 'native', { limit: 1, offset: 0, runId: 'other' }),
      /response-invalid/u,
    );
  });
});
