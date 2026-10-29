import assert from 'node:assert/strict';

import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
  type GatewayClient,
  type EventLoopReadyResult,
  type GatewayClientOptions,
} from '@openclaw/gateway-client';

import {
  sessionDispatchRequest,
  useSessionDispatchClient,
} from '../credentials/session-dispatch-client.ts';
import type { ReadinessOptions } from '../credentials/session-dispatch-readiness.ts';
import { observeReadiness } from '../credentials/session-dispatch-readiness-evidence.ts';
import gatewayRequestFixture from './gateway-request-fixture.ts';
import type {
  DispatchCredential,
  DispatchRequest,
  DispatchAuthority,
} from '../credentials/session-dispatch.ts';

function connectionFixture(
  start: (options: GatewayClientOptions, deadline: () => void) => void,
  authority: DispatchAuthority = {},
  shutdownFails = false,
  waitForGateway: (options: ReadinessOptions) => Promise<EventLoopReadyResult> = async () => ({
    ready: true,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 1,
    aborted: false,
  }),
) {
  const calls: string[] = [];
  let deadline = () => {};
  const record: DispatchCredential = {
    version: 1,
    device: {
      deviceId: 'a'.repeat(64),
      privateKeyPem: 'fixture-private-key',
      publicKeyPem: 'fixture-public-key',
    },
    token: 'fixture-device-token',
  };
  return {
    calls,
    expire: () => deadline(),
    run: () =>
      useSessionDispatchClient(
        {},
        record,
        false,
        authority,
        async () => {
          calls.push('operation');
          return 'ready';
        },
        {
          waitForGateway: (_port, _authority, options) => waitForGateway(options),
          createClient(options) {
            assert.deepEqual(options.env, {});
            assert.equal(options.requestTimeoutMs, undefined);
            assert.equal(options.deviceToken, record.token);
            assert.equal(options.deviceIdentity, record.device);
            return {
              start() {
                calls.push('start');
                start(options, () => deadline());
              },
              stop() {
                calls.push('stop');
              },
              async stopAndWait() {
                calls.push('shutdown');
                if (shutdownFails) throw new Error('private-shutdown-token');
              },
              async request<T>() {
                return undefined as T;
              },
            };
          },
          scheduleDeadline(callback, milliseconds) {
            assert.equal(
              milliseconds,
              DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS +
                DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS +
                (authority.waitForGateway ? 90_000 : 0),
            );
            deadline = callback;
            return () => {
              calls.push('clear-deadline');
            };
          },
        },
      ),
  };
}

describe('credentials/session-dispatch-client', () => {
  for (const ending of ['success', 'timeout', 'cancel', 'shorter-deadline'] as const) {
    it(`should apply the creation budget at the device sdk call for ${ending}`, async () => {
      const rpc = gatewayRequestFixture();
      const controller = new AbortController();
      if (ending === 'shorter-deadline')
        rpc.deadline(10_000, () => controller.abort(new Error(ending)));
      const pending = useSessionDispatchClient(
        {},
        { version: 1, device: { deviceId: 'fixture', privateKeyPem: '', publicKeyPem: '' } },
        false,
        { signal: controller.signal },
        async (request) => {
          await request('sessions.describe', {});
          return request('sessions.create', {});
        },
        {
          scheduleDeadline: () => () => {},
          createClient(options) {
            assert.equal(options.requestTimeoutMs, undefined);
            return {
              start() {
                options.onHelloOk!({ auth: { scopes: [] } } as unknown as Parameters<
                  NonNullable<GatewayClientOptions['onHelloOk']>
                >[0]);
              },
              stop() {},
              async stopAndWait() {},
              async request<T>(...args: Parameters<GatewayClient['request']>) {
                const [method, , requestOptions] = args;
                if (method !== 'sessions.create') {
                  assert.equal(requestOptions, undefined);
                  return {} as T;
                }
                assert.equal(requestOptions?.timeoutMs, 120_000);
                assert.equal(requestOptions?.signal, controller.signal);
                return rpc.request(
                  requestOptions?.timeoutMs ?? undefined,
                  requestOptions?.signal,
                ) as Promise<T>;
              },
            };
          },
        },
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
        assert.ok('error' in result && result.error instanceof Error);
        assert.equal(
          result.error.message,
          ending === 'timeout' ? 'session-dispatch-create-timeout-unverified' : ending,
        );
      }
      assert.equal(rpc.calls(), 1);
    });
  }

  it('should leave retryable install transport recovery to the sdk without ignoring gateway rejection', async () => {
    for (const install of [false, true]) {
      for (const rejection of [false, true]) {
        const f = connectionFixture(
          (options) => {
            options.onConnectError!(
              rejection
                ? new GatewayClientRequestError({ code: 'FORBIDDEN', message: 'private-token' })
                : Object.assign(new Error('private-token'), { code: 'ECONNRESET' }),
            );
            options.onHelloOk!({ auth: { scopes: [] } } as unknown as Parameters<
              NonNullable<GatewayClientOptions['onHelloOk']>
            >[0]);
          },
          { waitForGateway: install },
        );
        if (install && !rejection) assert.equal(await f.run(), 'ready');
        else await assert.rejects(f.run());
        assert.equal(f.calls.filter((call) => call === 'start').length, 1);
        assert.equal(f.calls.includes('operation'), install && !rejection);
        assert.equal(f.calls.at(-1), 'shutdown');
      }
    }
  });

  it('should cancel an outstanding readiness probe on deadline or operator cancellation before starting the client', async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      let probeSignal: AbortSignal | undefined;
      const f = connectionFixture(
        () => assert.fail('client must not start'),
        { waitForGateway: true, signal: controller.signal },
        false,
        (options) =>
          new Promise((_resolve, reject) => {
            probeSignal = options.signal;
            options.signal!.addEventListener('abort', () => reject(new Error('probe-aborted')), {
              once: true,
            });
            entered.resolve();
          }),
      );
      const pending = f.run();
      await entered.promise;
      const failure = new Error('operator-cancelled');
      if (cancel) controller.abort(failure);
      else f.expire();
      await assert.rejects(pending, (error: unknown) => {
        if (cancel) return error === failure;
        assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
        assert.deepEqual(error.sessionDispatchDiagnostic, {
          category: 'timeout',
          phase: 'connection',
          reasonCode: 'gateway-readiness-deadline',
          readinessEvidence: {
            state: 'absent',
            elapsedMs: null,
            maxWaitMs: null,
            totalObservations: 0,
            droppedObservations: 0,
            observations: [],
          },
        });
        return true;
      });
      assert.equal(probeSignal?.aborted, true);
      assert.ok(!f.calls.includes('start'));
      assert.ok(!f.calls.includes('operation'));
      assert.equal(f.calls.at(-1), 'shutdown');
    }
  });

  it('should preserve the last completed readiness evidence when the outer deadline aborts an outstanding probe', async () => {
    const entered = Promise.withResolvers<void>();
    const evidence = {
      state: 'observed' as const,
      elapsedMs: 500,
      maxWaitMs: 30_000,
      totalObservations: 1,
      droppedObservations: 0,
      observations: [
        observeReadiness('/startupz', 500, {
          statusCode: 503,
          body: { ok: false, status: 'starting' },
        }),
      ],
    };
    const f = connectionFixture(
      () => assert.fail('authentication must not start'),
      { waitForGateway: true },
      false,
      (options) =>
        new Promise((_resolve, reject) => {
          options.onEvidence!(evidence);
          options.signal!.addEventListener('abort', () => reject(new Error('private-token')), {
            once: true,
          });
          entered.resolve();
        }),
    );
    const pending = f.run();
    await entered.promise;
    f.expire();
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
      assert.deepEqual(error.sessionDispatchDiagnostic, {
        category: 'timeout',
        phase: 'connection',
        reasonCode: 'gateway-readiness-deadline',
        readinessEvidence: evidence,
      });
      assert.ok(!JSON.stringify(error).includes('private-token'));
      return true;
    });
    assert.ok(!f.calls.includes('start'));
    assert.equal(f.calls.at(-1), 'shutdown');
  });

  it('should reserve authentication time after a cold reload consumes most of the readiness budget', async () => {
    let deadlineMs = 0;
    let expire = () => {};
    const result = await useSessionDispatchClient(
      {},
      {
        version: 1,
        device: { deviceId: 'a'.repeat(64), publicKeyPem: 'fixture', privateKeyPem: 'fixture' },
        token: 'retained-device',
      },
      false,
      { waitForGateway: true },
      async () => 'verified',
      {
        async waitForGateway(_port, _authority, options) {
          assert.equal(options.maxWaitMs, 90_000);
          return { ready: true, elapsedMs: 85_000, maxDriftMs: 0, checks: 1, aborted: false };
        },
        createClient(options) {
          assert.equal(options.deviceToken, 'retained-device');
          return {
            start() {
              // readiness consumes 85s, then authentication takes another 14s.
              if (deadlineMs <= 99_000) expire();
              else
                options.onHelloOk!({ auth: { scopes: [] } } as unknown as Parameters<
                  NonNullable<GatewayClientOptions['onHelloOk']>
                >[0]);
            },
            stop() {},
            async stopAndWait() {},
            async request<T>() {
              return undefined as T;
            },
          };
        },
        scheduleDeadline(callback, milliseconds) {
          deadlineMs = milliseconds;
          expire = callback;
          return () => {};
        },
      },
    );
    assert.equal(result, 'verified');
    assert.equal(deadlineMs, 135_000);
  });

  for (const deadline of [false, true]) {
    it(`should retain safe connection evidence from the ${deadline ? 'deadline' : 'callback'}`, async () => {
      const f = connectionFixture((options, expire) => {
        if (deadline) expire();
        else
          options.onConnectError!(
            Object.assign(new Error('private-token'), { code: 'ECONNREFUSED' }),
          );
      });
      await assert.rejects(f.run(), (error: unknown) => {
        assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
        assert.deepEqual(
          error.sessionDispatchDiagnostic,
          deadline
            ? { category: 'timeout', phase: 'unknown', reasonCode: 'enrollment-deadline' }
            : { category: 'transport', phase: 'connection', reasonCode: 'connection-refused' },
        );
        assert.equal(error.cause, undefined);
        assert.ok(!JSON.stringify(error).includes('private-token'));
        return true;
      });
      assert.ok(f.calls.includes('clear-deadline'));
      assert.equal(f.calls.at(-1), 'shutdown');
      assert.ok(!f.calls.includes('operation'));
    });
  }

  it('should preserve cancellation and authority failures during both connection outcomes', async () => {
    for (const remoteFails of [false, true]) {
      for (const cancelled of [false, true]) {
        const controller = new AbortController();
        const failure = new Error('authority-changed');
        let changed = false;
        const f = connectionFixture(
          (options) => {
            changed = true;
            if (cancelled) controller.abort(failure);
            if (remoteFails) options.onConnectError!(new Error('private-token'));
            else
              options.onHelloOk!({ auth: { scopes: [] } } as unknown as Parameters<
                NonNullable<GatewayClientOptions['onHelloOk']>
              >[0]);
          },
          {
            signal: controller.signal,
            assertEnrollmentCurrent() {
              if (changed && !cancelled) throw failure;
            },
          },
        );
        await assert.rejects(f.run(), (error: unknown) => error === failure);
        assert.ok(!f.calls.includes('operation'));
        assert.equal(f.calls.at(-1), 'shutdown');
        const stopped = f.calls.filter((call) => call === 'stop').length;
        controller.abort();
        assert.equal(f.calls.filter((call) => call === 'stop').length, stopped);
      }
    }
  });

  it('should preserve the primary failure and sanitize a cleanup-only failure', async () => {
    for (const remoteFails of [false, true]) {
      const f = connectionFixture(
        (options) => {
          if (remoteFails)
            options.onConnectError!(
              Object.assign(new Error('private-token'), { code: 'ECONNREFUSED' }),
            );
          else
            options.onHelloOk!({ auth: { scopes: [] } } as unknown as Parameters<
              NonNullable<GatewayClientOptions['onHelloOk']>
            >[0]);
        },
        {},
        true,
      );
      await assert.rejects(f.run(), (error: unknown) => {
        assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
        assert.deepEqual(
          error.sessionDispatchDiagnostic,
          remoteFails
            ? { category: 'transport', phase: 'connection', reasonCode: 'connection-refused' }
            : { category: 'unknown', phase: 'unknown', reasonCode: 'unknown' },
        );
        assert.ok(
          ![error.message, error.stack, JSON.stringify(error)].join('').includes('private-'),
        );
        return true;
      });
    }
  });

  it('should identify rejected methods without exposing provider payloads or retrying', async () => {
    for (const [method, expected] of [
      ['sessions.create', 'session-dispatch-create-request-invalid'],
      ['sessions.describe', 'session-dispatch-describe-request-invalid'],
      ['chat.history', 'session-dispatch-history-request-invalid'],
      ['chat.send', 'session-dispatch-chat-send-request-invalid'],
    ] as const) {
      let calls = 0;
      const request = sessionDispatchRequest(async () => {
        calls++;
        throw new GatewayClientRequestError({
          code: 'INVALID_REQUEST',
          message: 'private-token sessionId requires messageId',
          details: { token: 'private-token' },
        });
      }, {});
      await assert.rejects(request(method, {}), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, expected);
        assert.equal(error.cause, undefined);
        assert.ok(!JSON.stringify(error).includes('private-token'));
        return true;
      });
      assert.equal(calls, 1);
    }
  });

  it('should retain uncertain create outcomes for timeout and unrecognized failures', async () => {
    for (const [failure, expected] of [
      [
        new GatewayClientRequestTimeoutError({
          method: 'sessions.create',
          timeoutMs: 1,
          requestSent: true,
        }),
        'session-dispatch-create-timeout-unverified',
      ],
      [
        new GatewayClientRequestError({ code: 'UNAVAILABLE', message: 'private-token' }),
        'session-dispatch-create-unavailable-unverified',
      ],
      [
        new GatewayClientRequestError({ code: 'private-token', message: 'private-token' }),
        'session-dispatch-create-request-unverified',
      ],
      [new Error('private-token'), 'session-dispatch-create-request-unverified'],
    ] as const) {
      let calls = 0;
      const request = sessionDispatchRequest(async () => {
        calls++;
        throw failure;
      }, {});
      await assert.rejects(request('sessions.create', {}), { message: expected });
      assert.equal(calls, 1);
    }
  });

  it('should keep local cancellation and enrollment failures distinct after remote success or failure', async () => {
    for (const remoteFails of [false, true]) {
      for (const cancelled of [false, true]) {
        const controller = new AbortController();
        const failure = new Error(cancelled ? 'dispatch-cancelled' : 'dispatch-enrollment-changed');
        let changed = false;
        const request = sessionDispatchRequest(
          async () => {
            changed = true;
            if (cancelled) controller.abort(failure);
            if (remoteFails) throw new Error('remote-failure');
            return { sessionId: 'retained' };
          },
          {
            signal: controller.signal,
            assertEnrollmentCurrent() {
              if (changed && !cancelled) throw failure;
            },
          },
        );
        await assert.rejects(request('sessions.create', {}), (error: unknown) => error === failure);
      }
    }
  });

  it('should reject expired authority and unavailable methods before calling the transport', async () => {
    let calls = 0;
    const transport: DispatchRequest = async () => {
      calls++;
    };
    const failure = new Error('dispatch-policy-changed');
    const request = sessionDispatchRequest(transport, {
      async assertCurrent() {
        throw failure;
      },
    });
    await assert.rejects(request('chat.history', {}), (error: unknown) => error === failure);
    await assert.rejects(
      sessionDispatchRequest(transport, {})('config.apply', {}),
      /session-dispatch-method-unavailable/,
    );
    assert.equal(calls, 0);
  });

  it('should forward workflow families without adding a per-method permission gate', async () => {
    for (const method of [
      'sessions.create',
      'sessions.patchMany',
      'sessions.messages.subscribe',
      'sessions.messages.unsubscribe',
      'sessions.recover',
      'sessions.abort',
      'session.members.list',
      'chat.send',
      'chat.abort',
      'chat.startup',
      'chat.message.get',
      'agent',
      'agent.wait',
      'agent.identity.get',
      'agents.list',
      'models.list',
      'tools.effective',
      'tools.invoke',
      'skills.status',
      'commands.list',
      'artifacts.download',
      'progressCard.put',
      'audit.run.inspect',
      'cron.history',
      'question.waitAnswer',
      'exec.approval.waitDecision',
      'usage.status',
      'health',
      'status',
      'logs.tail',
      'sessions.futureOperation',
    ]) {
      const params = { sessionKey: 'issue', idempotencyKey: 'retained-attempt' };
      const result = { runId: 'retained-run', status: 'accepted' };
      let calls = 0;
      const request = sessionDispatchRequest(async (name, input) => {
        calls++;
        assert.equal(name, method);
        assert.equal(input, params);
        return result;
      }, {});
      assert.equal(await request(method, params), result);
      assert.equal(calls, 1);
    }
  });

  it('should leave gateway denials authoritative without retrying or exposing diagnostics', async () => {
    for (const method of ['sessions.reset', 'chat.inject', 'tools.invoke']) {
      let calls = 0;
      const request = sessionDispatchRequest(async () => {
        calls++;
        throw new GatewayClientRequestError({
          code: 'FORBIDDEN',
          message: 'private-token operator.admin required',
          details: { token: 'private-token' },
        });
      }, {});
      await assert.rejects(request(method, {}), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^session-dispatch-[a-z-]+-forbidden$/);
        assert.equal(error.cause, undefined);
        assert.ok(!JSON.stringify(error).includes('private-token'));
        return true;
      });
      assert.equal(calls, 1);
    }
  });

  it('should reject unrelated families and malformed method names before transport', async () => {
    let calls = 0;
    const request = sessionDispatchRequest(async () => {
      calls++;
    }, {});
    for (const method of [
      '',
      'config.apply',
      'device.token.rotate',
      'update.run',
      'node.invoke',
      'exec.approvals.set',
      'sessions',
      'sessionsOther.send',
      'sessions..send',
      'chat.send\nprivate-token',
      'chat.send private-token',
      `chat.${'a'.repeat(96)}`,
    ]) {
      await assert.rejects(request(method, {}), /session-dispatch-method-unavailable/);
    }
    assert.equal(calls, 0);
  });

  it('should preserve uncertain send outcomes without resubmitting', async () => {
    let calls = 0;
    const request = sessionDispatchRequest(async () => {
      calls++;
      throw new GatewayClientRequestTimeoutError({
        method: 'chat.send',
        timeoutMs: 1,
        requestSent: true,
      });
    }, {});
    await assert.rejects(request('chat.send', { idempotencyKey: 'one-attempt' }), {
      message: 'session-dispatch-chat-send-timeout-unverified',
    });
    assert.equal(calls, 1);
  });

  it('should preserve successful results after checking current authority', async () => {
    const result = { sessionId: 'retained' };
    const params = { sessionKey: 'issue' };
    const order: string[] = [];
    const request = sessionDispatchRequest(
      async (method, input) => {
        assert.equal(method, 'chat.history');
        assert.equal(input, params);
        order.push('request');
        return result;
      },
      {
        async assertCurrent() {
          order.push('authority');
        },
        assertEnrollmentCurrent() {
          order.push('enrollment');
        },
      },
    );
    assert.equal(await request('chat.history', params), result);
    assert.deepEqual(order, ['enrollment', 'authority', 'enrollment', 'request', 'enrollment']);
  });
});
