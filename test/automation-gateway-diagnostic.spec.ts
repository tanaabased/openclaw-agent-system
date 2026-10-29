import assert from 'node:assert/strict';

import automationGatewayDiagnostic, {
  retainAutomationGatewayDiagnostic,
} from '../agent/automation-gateway-diagnostic.ts';
import { AutomationError } from '../agent/automation-gateway.ts';

describe('agent/automation-gateway-diagnostic', () => {
  it('should retain bounded opt-in rejection evidence without credentials payloads or arbitrary details', () => {
    const error = Object.assign(
      new Error('Native snapshot rejected; opaque-secret token=hidden payload={private input}'),
      {
        name: 'GatewayClientRequestError',
        gatewayCode: 'INVALID_REQUEST',
        retryable: false,
        details: {
          code: 'SNAPSHOT_INVALID',
          secret: 'private-detail',
          nested: { token: 'hidden' },
        },
      },
    );
    assert.equal(automationGatewayDiagnostic('sessions.create', error).nativeRejection, undefined);
    const diagnostic = automationGatewayDiagnostic('sessions.create', error, {
      secrets: ['opaque-secret'],
    });
    assert.equal(diagnostic.reason, 'unclassified');
    assert.equal(diagnostic.nativeRejection?.detailCode, 'SNAPSHOT_INVALID');
    assert.match(diagnostic.nativeRejection!.message!, /Native snapshot rejected/);
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      /opaque-secret|hidden|private input|private-detail|nested/,
    );
    assert.deepEqual(retainAutomationGatewayDiagnostic(diagnostic), diagnostic);
    const long = automationGatewayDiagnostic(
      'sessions.create',
      Object.assign(error, { message: 'x'.repeat(4000) }),
      { secrets: [] },
    );
    assert.ok(long.nativeRejection!.message!.length <= 1025);
    assert.equal(
      automationGatewayDiagnostic('cron.add', error, { secrets: [] }).nativeRejection,
      undefined,
    );
  });

  it('should retain native runtime restrictions and catalog readiness without copying private details', () => {
    for (const [gatewayCode, message, details, expected] of [
      [
        'INVALID_REQUEST',
        'secret message',
        {
          code: 'AGENT_RUNTIME_RESTRICTED',
          runtimeId: 'secret-runtime',
          recovery: { sessionId: 'secret-id' },
        },
        'runtime-restricted',
      ],
      [
        'UNAVAILABLE',
        'model catalog is still loading; retry in a few seconds',
        { token: 'secret-token' },
        'model-catalog-loading',
      ],
    ] as const) {
      const error = Object.assign(new Error(message), {
        name: 'GatewayClientRequestError',
        gatewayCode,
        retryable: false,
        details,
      });
      const diagnostic = automationGatewayDiagnostic('sessions.create', error);
      assert.equal(diagnostic.reason, expected);
      assert.deepEqual(retainAutomationGatewayDiagnostic(diagnostic), diagnostic);
      assert.doesNotMatch(JSON.stringify(diagnostic), /secret/);
      assert.equal(
        retainAutomationGatewayDiagnostic({ ...diagnostic, method: 'cron.add' }).reason,
        undefined,
      );
    }
  });
  it('should retain only bounded automation identity for session creation diagnostics', () => {
    const diagnostic = {
      method: 'sessions.create',
      category: 'rejected',
      gatewayCode: 'INVALID_REQUEST',
      reason: 'unclassified',
    };
    assert.equal(
      retainAutomationGatewayDiagnostic({ ...diagnostic, automationId: 'github-issue-assignment' })
        .automationId,
      'github-issue-assignment',
    );
    for (const automationId of ['private/token', 'token\nvalue', 'a'.repeat(129), {}, null])
      assert.equal(
        retainAutomationGatewayDiagnostic({ ...diagnostic, automationId }).automationId,
        undefined,
      );
    assert.equal(
      retainAutomationGatewayDiagnostic({
        ...diagnostic,
        method: 'cron.add',
        automationId: 'intake',
      }).automationId,
      undefined,
    );
  });
  it('should retain bounded create and patch rejection reasons without model values or raw payloads', () => {
    for (const method of ['sessions.create', 'sessions.patch'] as const) {
      for (const [message, reason] of [
        [`invalid ${method} params: secret-payload`, 'parameters-invalid'],
        ['model not allowed: secret-model', 'model-not-allowed'],
        ['invalid model: secret-model', 'model-invalid'],
        ['invalid thinkingLevel (use secret-levels)', 'effort-invalid'],
        ['Unknown agent id "secret-agent"', 'agent-unknown'],
        [
          'Model secret/model requires agent harness "secret-runtime", but no enabled plugin provides it. Install and enable its plugin, restart the Gateway, then select the model again.',
          'model-runtime-unavailable',
        ],
        ['Model selection is locked for this session.', 'model-selection-locked'],
        [
          'A runtime is not available for secret-provider/secret-model. Refresh the model catalog and choose again.',
          'model-runtime-unavailable',
        ],
        [
          'Runtime "secret-runtime" is not available for secret-provider/secret-model. Refresh the model catalog and choose again.',
          'model-runtime-unavailable',
        ],
        ['A runtime is not available for secret-model for another reason.', 'unclassified'],
        [
          'Session key namespace is reserved for agent harness-owned sessions.',
          'session-key-reserved',
        ],
        ['sessions.create cwd must be absolute', 'workspace-invalid'],
        ['new native rejection containing secret-token', 'unclassified'],
        [
          'thinkingLevel "secret-effort" is not supported for secret-provider/secret-model (use secret-levels)',
          'effort-unsupported',
        ],
      ]) {
        const error = Object.assign(new Error(message), {
          name: 'GatewayClientRequestError',
          gatewayCode: 'INVALID_REQUEST',
          retryable: false,
        });
        const diagnostic = automationGatewayDiagnostic(method, error);
        assert.equal(diagnostic.reason, reason);
        assert.deepEqual(retainAutomationGatewayDiagnostic(diagnostic), diagnostic);
        assert.ok(
          !new AutomationError('automation-gateway-rejected', diagnostic).message.includes(
            'secret',
          ),
        );
        assert.ok(!JSON.stringify(diagnostic).includes('secret'));
        assert.equal(automationGatewayDiagnostic('cron.add', error).reason, undefined);
        error.gatewayCode = 'FORBIDDEN';
        assert.equal(automationGatewayDiagnostic(method, error).reason, undefined);
        assert.equal(
          retainAutomationGatewayDiagnostic({ ...diagnostic, category: 'timeout' }).reason,
          undefined,
        );
      }
    }
  });
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
      assert.equal(automationGatewayDiagnostic('sessions.create', error).reason, reason);
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
      reason: 'unclassified',
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
