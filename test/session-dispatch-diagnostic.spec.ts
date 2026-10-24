import assert from 'node:assert/strict';

import {
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
} from '@openclaw/gateway-client';

import {
  classifySessionDispatchFailure,
  retainSessionDispatchDiagnostic,
  SessionDispatchConnectionError,
  sessionDispatchDeadlineError,
} from '../credentials/session-dispatch-diagnostic.ts';

describe('credentials/session-dispatch-diagnostic', () => {
  it('should classify only structured known evidence without guessing a phase', () => {
    const cases = [
      [sessionDispatchDeadlineError(), 'timeout', 'unknown', 'enrollment-deadline'],
      [
        new GatewayClientRequestTimeoutError({
          method: 'connect',
          timeoutMs: 1,
          requestSent: true,
        }),
        'timeout',
        'handshake',
        'connect-request-timeout',
      ],
      [
        new GatewayClientRequestTimeoutError({
          method: 'connect',
          timeoutMs: 1,
          requestSent: false,
        }),
        'timeout',
        'unknown',
        'connect-unsent-timeout',
      ],
      [
        new GatewayClientRequestError({ code: 'FORBIDDEN' }),
        'gateway-rejected',
        'unknown',
        'forbidden',
      ],
      [
        new GatewayClientRequestError({ code: 'INVALID_REQUEST' }),
        'gateway-rejected',
        'unknown',
        'request-invalid',
      ],
      [
        new GatewayClientRequestError({ code: 'UNAVAILABLE' }),
        'gateway-rejected',
        'unknown',
        'unavailable',
      ],
      [
        new GatewayClientRequestError({
          code: 'UNAVAILABLE',
          details: { reason: 'websocket-upgrade-rejected' },
        }),
        'gateway-rejected',
        'connection',
        'websocket-upgrade-rejected',
      ],
      [
        Object.assign(new Error(), { code: 'ECONNREFUSED' }),
        'transport',
        'connection',
        'connection-refused',
      ],
      [
        Object.assign(new Error(), { code: 'ENOTFOUND' }),
        'transport',
        'connection',
        'host-not-found',
      ],
      [
        Object.assign(new Error(), { code: 'ECONNRESET' }),
        'transport',
        'unknown',
        'connection-reset',
      ],
      [Object.assign(new Error(), { code: 'EPIPE' }), 'transport', 'unknown', 'broken-pipe'],
      [
        Object.assign(new Error(), { code: 'ETIMEDOUT' }),
        'timeout',
        'unknown',
        'transport-timeout',
      ],
    ] as const;
    for (const [error, category, phase, reasonCode] of cases)
      assert.deepEqual(classifySessionDispatchFailure(error), { category, phase, reasonCode });
  });

  it('should leave insufficient, malformed and prose-only evidence unknown', () => {
    for (const error of [
      undefined,
      null,
      'timeout ECONNREFUSED',
      { code: 'ECONNREFUSED' },
      { category: 'timeout', phase: 'handshake', reasonCode: 'connect-request-timeout' },
      new Error('timeout ECONNREFUSED websocket-upgrade-rejected'),
      new GatewayClientRequestTimeoutError({
        method: 'chat.send',
        timeoutMs: 1,
        requestSent: true,
      }),
      new GatewayClientRequestError({
        code: 'SECRET',
        details: { reason: 'websocket-upgrade-rejected' },
      }),
      Object.assign(new Error(), { code: ['ECONNREFUSED'] }),
    ])
      assert.deepEqual(classifySessionDispatchFailure(error), {
        category: 'unknown',
        phase: 'unknown',
        reasonCode: 'unknown',
      });
    for (const value of [
      undefined,
      null,
      {},
      { category: 'transport', phase: 'handshake', reasonCode: 'connection-refused' },
      { reasonCode: '__proto__' },
    ])
      assert.deepEqual(retainSessionDispatchDiagnostic(value), {
        category: 'unknown',
        phase: 'unknown',
        reasonCode: 'unknown',
      });
  });

  it('should exclude unrestricted content and rebuild metadata at retention boundaries', () => {
    const marker = 'fixture-secret-token-key-environment';
    const raw = Object.assign(
      new GatewayClientRequestError({
        code: 'FORBIDDEN',
        message: marker,
        details: { token: marker, reason: marker },
      }),
      { stack: marker, cause: new Error(marker), responsePayload: { token: marker } },
    );
    const diagnostic = classifySessionDispatchFailure(raw);
    const safe = new SessionDispatchConnectionError(Object.assign(diagnostic, { token: marker }));
    assert.deepEqual(safe.sessionDispatchDiagnostic, {
      category: 'gateway-rejected',
      phase: 'unknown',
      reasonCode: 'forbidden',
    });
    assert.equal(safe.cause, undefined);
    assert.ok(![JSON.stringify(safe), safe.message, safe.stack!].join('').includes(marker));
    assert.deepEqual(
      classifySessionDispatchFailure(Object.assign(new Error(marker), { code: marker })),
      { category: 'unknown', phase: 'unknown', reasonCode: 'unknown' },
    );
    assert.notEqual(safe.sessionDispatchDiagnostic, diagnostic);
  });
});
