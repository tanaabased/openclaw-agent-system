import assert from 'node:assert/strict';

import { createAutomationGateway } from '../agent/automations/automation-gateway.ts';
import waitForAutomationGateway from '../agent/automations/automation-gateway-readiness.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import waitForSessionDispatchGateway from '../credentials/session-dispatch-readiness.ts';

describe('agent/automation-gateway-readiness', () => {
  it('should defer model and session reads during native reload without initiating another reload', async () => {
    for (const method of ['models.list', 'sessions.resolve'] as const) {
      let elapsed = 0;
      const calls: string[] = [];
      const request = createAutomationGateway(
        async (method) => {
          assert.ok(elapsed >= 1_000, 'must not dispatch while the native gateway is reloading');
          calls.push(method);
          return { ok: true };
        },
        undefined,
        () =>
          waitForAutomationGateway({
            isLocal: async () => true,
            readConfig: () => ({ gateway: { port: 23456 } }),
            port: (config) => config.gateway!.port!,
            wait: (port, authority, options) =>
              waitForSessionDispatchGateway(port, authority, options, {
                now: () => elapsed,
                sleep: async (ms) => {
                  elapsed += ms;
                },
                request: async (port, path) => {
                  assert.equal(port, 23456);
                  return path === '/startupz'
                    ? { statusCode: 200, body: { ok: true, status: 'started' } }
                    : elapsed < 1_000
                      ? {
                          statusCode: 503,
                          body: {
                            ready: false,
                            failing: ['plugin-reload'],
                            pluginReload: { phase: 'reloading' },
                          },
                        }
                      : { statusCode: 200, body: { ready: true, failing: [] } };
                },
              }),
          }),
      );
      assert.deepEqual(await request(method, {}), { ok: true });
      assert.deepEqual(calls, [method]);
    }
  });

  it('should preserve readiness failure or cancellation and never dispatch the model read', async () => {
    for (const outcome of ['failed', 'deadline', 'cancelled'] as const) {
      let elapsed = 0;
      const controller = new AbortController();
      const request = createAutomationGateway(
        async () => assert.fail('must not dispatch'),
        undefined,
        () =>
          waitForAutomationGateway({
            isLocal: async () => true,
            readConfig: () => ({}),
            port: () => 23456,
            wait: (port, authority, options) =>
              waitForSessionDispatchGateway(port, authority, options, {
                now: () => elapsed,
                sleep: async (ms) => {
                  elapsed += ms;
                },
                request: async (_port, path, _timeout, signal) => {
                  assert.equal(signal, controller.signal);
                  if (outcome === 'cancelled') controller.abort(new Error('cancelled'));
                  return path === '/startupz'
                    ? { statusCode: 200, body: { ok: true, status: 'started' } }
                    : {
                        statusCode: 503,
                        body: {
                          ready: false,
                          failing: ['plugin-reload'],
                          pluginReload: { phase: outcome === 'failed' ? 'failed' : 'reloading' },
                        },
                      };
                },
              }),
          }),
      );
      await assert.rejects(
        withPrivateStateLock({ signal: controller.signal, assertHeld() {} }, () =>
          request('models.list', {}),
        ),
        outcome === 'cancelled'
          ? { message: 'cancelled' }
          : {
              code:
                outcome === 'failed'
                  ? 'automation-gateway-reload-failed'
                  : 'automation-gateway-readiness-deadline',
            },
      );
      if (outcome === 'deadline') assert.equal(elapsed, 90_000);
    }
  });

  it('should not probe unrelated loopback endpoints for remote or tls gateway targets', async () => {
    for (const target of ['remote', 'tls'] as const) {
      let dispatched = false;
      const request = createAutomationGateway(
        async () => {
          dispatched = true;
          return {};
        },
        undefined,
        () =>
          waitForAutomationGateway({
            isLocal: async () => target !== 'remote',
            readConfig: () => {
              assert.equal(target, 'tls');
              return { gateway: { tls: { enabled: true } } };
            },
            port: () => assert.fail('must not select a local http endpoint'),
            wait: async () => assert.fail('must not probe'),
          }),
      );
      await request('models.list', {});
      assert.equal(dispatched, true);
    }
  });
});
