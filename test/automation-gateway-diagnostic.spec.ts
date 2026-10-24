import assert from 'node:assert/strict';

import automationGatewayDiagnostic, {
  retainAutomationGatewayDiagnostic,
} from '../agent/automation-gateway-diagnostic.ts';
import { AutomationError } from '../agent/automation-gateway.ts';

describe('agent/automation-gateway-diagnostic', () => {
  it('should rebuild retained evidence without extra fields or serialization hooks', () => {
    const value = {
      method: 'sessions.resolve',
      category: 'rejected',
      gatewayCode: 'INVALID_REQUEST',
      reason: 'agent-unknown',
      closeCode: 1006,
      requestDispatched: true,
      token: 'secret',
      connectionDetails: { url: 'ws://secret' },
      toJSON: () => ({ token: 'secret' }),
    };
    assert.deepEqual(retainAutomationGatewayDiagnostic(value), {
      method: 'sessions.resolve',
      category: 'rejected',
      gatewayCode: 'INVALID_REQUEST',
      closeCode: null,
      requestDispatched: null,
      reason: 'agent-unknown',
    });
    for (const overrides of [
      { method: 'cron.list' },
      { category: 'timeout' },
      { gatewayCode: 'FORBIDDEN' },
      { reason: 'secret' },
    ])
      assert.equal(retainAutomationGatewayDiagnostic({ ...value, ...overrides }).reason, undefined);
  });

  it('should leave missing or invalid retained evidence explicitly unknown', () => {
    for (const value of [
      undefined,
      null,
      'secret',
      {
        method: 'secret',
        category: 'secret',
        gatewayCode: 'secret',
        closeCode: 987654321,
        requestDispatched: 'secret',
        reason: 'secret',
      },
    ])
      assert.deepEqual(retainAutomationGatewayDiagnostic(value), {
        method: null,
        category: 'unknown',
        gatewayCode: null,
        closeCode: null,
        requestDispatched: null,
      });
    for (const category of ['timeout', 'closed']) {
      assert.deepEqual(
        retainAutomationGatewayDiagnostic({
          method: 'cron.get',
          category,
          closeCode: 1006,
          requestDispatched: false,
        }),
        {
          method: 'cron.get',
          category,
          gatewayCode: null,
          closeCode: category === 'closed' ? 1006 : null,
          requestDispatched: false,
        },
      );
      const invalid = retainAutomationGatewayDiagnostic({
        category,
        closeCode: 987654321,
        requestDispatched: 'false',
      });
      assert.equal(invalid.closeCode, null);
      assert.equal(invalid.requestDispatched, null);
    }
    assert.equal(
      retainAutomationGatewayDiagnostic({ category: 'rejected', gatewayCode: 'secret' })
        .gatewayCode,
      null,
    );
  });

  it('should distinguish known resolver rejections without retaining identifiers or changing retry policy', () => {
    for (const [message, reason] of [
      ['Unknown agent id "secret-agent"', 'agent-unknown'],
      [
        'agent "secret-agent" does not match session key agent "secret-other"',
        'agent-session-mismatch',
      ],
      ['malformed session key "secret-key"', 'session-key-malformed'],
      ['session key belongs to retired agent "secret-agent"', 'agent-retired'],
      ['invalid sessions.resolve params: secret-value', 'parameters-invalid'],
    ]) {
      const error = Object.assign(new Error(message), {
        name: 'GatewayClientRequestError',
        gatewayCode: 'INVALID_REQUEST',
        retryable: false,
      });
      const diagnostic = automationGatewayDiagnostic('sessions.resolve', error);
      assert.equal(diagnostic.reason, reason);
      const retained = new AutomationError('automation-gateway-rejected', diagnostic);
      assert.ok(retained.message.includes(`sessions.resolve: ${reason}`));
      assert.ok(!JSON.stringify(diagnostic).includes('secret'));
      assert.ok(!retained.message.includes('secret'));
      assert.equal(automationGatewayDiagnostic('sessions.create', error).reason, undefined);
      error.gatewayCode = 'UNAVAILABLE';
      assert.equal(automationGatewayDiagnostic('sessions.resolve', error).reason, undefined);
      assert.equal(
        automationGatewayDiagnostic('sessions.resolve', new Error(message)).reason,
        undefined,
      );
    }
  });

  it('should retain rejected request codes without upstream prose or payloads', () => {
    const error = Object.assign(new Error('secret request payload'), {
      name: 'GatewayClientRequestError',
      gatewayCode: 'INVALID_REQUEST',
      retryable: false,
      details: { token: 'secret' },
    });
    assert.deepEqual(automationGatewayDiagnostic('sessions.create', error), {
      method: 'sessions.create',
      category: 'rejected',
      gatewayCode: 'INVALID_REQUEST',
      closeCode: null,
      requestDispatched: null,
    });
    error.gatewayCode = 'SECRET_PROVIDER_CODE';
    const unknown = automationGatewayDiagnostic('sessions.patch', error);
    assert.equal(unknown.category, 'rejected');
    assert.equal(unknown.gatewayCode, null);
    assert.ok(!JSON.stringify(unknown).toLowerCase().includes('secret'));
  });

  it('should distinguish timeouts from closures and preserve uncertain write dispatch', () => {
    for (const kind of ['timeout', 'closed'] as const) {
      for (const requestDispatched of [true, false, undefined]) {
        const error = Object.assign(new Error('secret connection URL'), {
          name: 'GatewayTransportError',
          kind,
          connectionDetails: { message: 'secret' },
          code: 1006,
          reason: 'secret',
          requestDispatched,
        });
        assert.deepEqual(automationGatewayDiagnostic('sessions.patch', error), {
          method: 'sessions.patch',
          category: kind,
          gatewayCode: null,
          closeCode: kind === 'closed' ? 1006 : null,
          requestDispatched: requestDispatched ?? null,
        });
        error.code = 987654321;
        assert.equal(automationGatewayDiagnostic('sessions.patch', error).closeCode, null);
      }
    }
  });

  it('should leave unrecognized failures unknown without guessing from their messages', () => {
    for (const error of [
      new Error('secret: gateway timeout'),
      'secret',
      null,
      { code: 'secret', details: 'secret' },
    ])
      assert.deepEqual(automationGatewayDiagnostic('cron.list', error), {
        method: 'cron.list',
        category: 'unknown',
        gatewayCode: null,
        closeCode: null,
        requestDispatched: null,
      });
  });
});
