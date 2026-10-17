import assert from 'node:assert/strict';

import automationGatewayDiagnostic from '../agent/automation-gateway-diagnostic.ts';

describe('agent/automation-gateway-diagnostic', () => {
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
