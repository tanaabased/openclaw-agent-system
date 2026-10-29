import assert from 'node:assert/strict';

import {
  AutomationError,
  isOperatorAutomationGateway,
  createAutomationGateway,
  listNativeAutomations,
  nativeAutomation,
  nativeAutomationRun,
  nativeAutomationHistory,
} from '../agent/automation-gateway.ts';
import { privateStateFileLockLostErrorCode } from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import { controlledFileLock } from './private-state-file-lock-fixture.ts';
import gatewayRequestFixture from './gateway-request-fixture.ts';

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
  it('should enable rejection capture only in explicitly debugged ci without retrying the mutation', async () => {
    const previous = {
      CI: process.env.CI,
      OPENCLAW_DEBUG: process.env.OPENCLAW_DEBUG,
      TEST_SECRET: process.env.TEST_SECRET,
    };
    try {
      process.env.TEST_SECRET = 'opaque-test-secret';
      for (const [ci, debug, capture] of [
        ['false', '1', false],
        ['true', '0', false],
        ['true', '1', true],
      ] as const) {
        process.env.CI = ci;
        process.env.OPENCLAW_DEBUG = debug;
        let calls = 0;
        const request = createAutomationGateway(async () => {
          calls++;
          throw Object.assign(
            new Error('snapshot rejected for private-session with opaque-test-secret'),
            {
              name: 'GatewayClientRequestError',
              gatewayCode: 'INVALID_REQUEST',
              retryable: false,
            },
          );
        });
        await assert.rejects(
          request('sessions.create', { key: 'private-session' }),
          (error: unknown) => {
            assert.ok(error instanceof AutomationError);
            assert.equal(Boolean(error.diagnostic?.nativeRejection), capture);
            assert.doesNotMatch(
              JSON.stringify(error.diagnostic),
              /opaque-test-secret|private-session/,
            );
            return true;
          },
        );
        assert.equal(calls, 1);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  for (const ending of ['success', 'timeout', 'cancel', 'shorter-deadline'] as const) {
    it(`should apply the creation budget at the cli sdk call for ${ending}`, async () => {
      const rpc = gatewayRequestFixture(
        Object.assign(new Error('timeout'), {
          name: 'GatewayTransportError',
          kind: 'timeout',
          connectionDetails: {},
          requestDispatched: true,
        }),
      );
      const controller = new AbortController();
      if (ending === 'shorter-deadline')
        rpc.deadline(10_000, () => controller.abort(new Error(ending)));
      const request = createAutomationGateway(async (method, options, _params, extra) => {
        assert.equal(method, 'sessions.create');
        assert.equal(options.timeout, '120000');
        assert.equal(extra?.signal, controller.signal);
        return rpc.request(Number(options.timeout), extra?.signal);
      });
      const pending = withPrivateStateLock({ assertHeld() {}, signal: controller.signal }, () =>
        request('sessions.create', {}),
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await Promise.race([
        rpc.dispatched,
        outcome.then(() => assert.fail('sdk request was not dispatched')),
      ]);
      rpc.advance(ending === 'shorter-deadline' ? 5_000 : 30_001);
      assert.equal(rpc.settled(), false);
      if (ending === 'success') {
        rpc.advance(14_999);
        rpc.complete();
        assert.deepEqual(await outcome, { value: { key: 'created' } });
      } else {
        if (ending === 'timeout') rpc.advance(90_000);
        else {
          if (ending === 'shorter-deadline') rpc.advance(5_000);
          else controller.abort(new Error(ending));
        }
        const result = await outcome;
        assert.ok('error' in result && result.error instanceof AutomationError);
        if (ending === 'timeout') assert.equal(result.error.diagnostic?.category, 'timeout');
      }
      assert.equal(rpc.calls(), 1);
    });
  }

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
        method === 'sessions.create' ? { timeout: '120000' } : {},
        { id: 'fixture' },
        {
          progress: false,
          scopes: [
            readOnly
              ? 'operator.read'
              : method.startsWith('sessions.')
                ? 'operator.write'
                : 'operator.admin',
          ],
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
  it('should distinguish operator inspection from an arbitrary restricted reader', () => {
    const restricted = async () => ({ jobs: [], hasMore: false });
    assert.equal(isOperatorAutomationGateway(restricted), false);
    assert.equal(isOperatorAutomationGateway(createAutomationGateway(restricted)), true);
  });

  it('should reject inconsistent native pagination evidence', async () => {
    const first = Array.from({ length: 200 }, (_, n) => job(String(n)));
    for (const invalid of [
      { offset: 1 },
      { limit: 10 },
      { total: -1 },
      { total: 2.5 },
      { total: 1 },
      { nextOffset: 1 },
    ]) {
      await assert.rejects(
        listNativeAutomations(async () => ({ jobs: [], hasMore: false, ...invalid })),
        /snapshot-diverged/u,
      );
    }
    for (const changed of [{ total: 202 }, { nextOffset: 201 }, { offset: 0 }]) {
      await assert.rejects(
        listNativeAutomations(async (_method, params) =>
          params.offset === 0
            ? { jobs: first, hasMore: true, total: 201, offset: 0, limit: 200, nextOffset: 200 }
            : {
                jobs: [job('last')],
                hasMore: false,
                total: 201,
                offset: 200,
                limit: 200,
                nextOffset: null,
                ...changed,
              },
        ),
        /snapshot-diverged/u,
      );
    }
    assert.equal(
      (
        await listNativeAutomations(async (_method, params) =>
          params.offset === 0
            ? { jobs: first, hasMore: true, total: 201, offset: 0, limit: 200, nextOffset: 200 }
            : {
                jobs: [job('last')],
                hasMore: false,
                total: 201,
                offset: 200,
                limit: 200,
                nextOffset: null,
              },
        )
      ).length,
      201,
    );
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
