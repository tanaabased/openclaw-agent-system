import {
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
} from '@openclaw/gateway-client';

export interface SessionDispatchDiagnostic {
  category: 'timeout' | 'transport' | 'gateway-rejected' | 'unknown';
  phase: 'connection' | 'handshake' | 'unknown';
  reasonCode: keyof typeof diagnostics;
}

const diagnostics = {
  unknown: { category: 'unknown', phase: 'unknown' },
  'enrollment-deadline': { category: 'timeout', phase: 'unknown' },
  'connect-request-timeout': { category: 'timeout', phase: 'handshake' },
  'connect-unsent-timeout': { category: 'timeout', phase: 'unknown' },
  'connection-refused': { category: 'transport', phase: 'connection' },
  'host-not-found': { category: 'transport', phase: 'connection' },
  'connection-reset': { category: 'transport', phase: 'unknown' },
  'broken-pipe': { category: 'transport', phase: 'unknown' },
  'transport-timeout': { category: 'timeout', phase: 'unknown' },
  forbidden: { category: 'gateway-rejected', phase: 'unknown' },
  'request-invalid': { category: 'gateway-rejected', phase: 'unknown' },
  unavailable: { category: 'gateway-rejected', phase: 'unknown' },
  'websocket-upgrade-rejected': { category: 'gateway-rejected', phase: 'connection' },
} as const;

/** rebuild only known triples; never retain arbitrary properties from errors or payloads. */
export function retainSessionDispatchDiagnostic(value: unknown): SessionDispatchDiagnostic {
  if (
    value &&
    typeof value === 'object' &&
    'reasonCode' in value &&
    typeof value.reasonCode === 'string' &&
    Object.hasOwn(diagnostics, value.reasonCode)
  ) {
    const reasonCode = value.reasonCode as keyof typeof diagnostics;
    const expected = diagnostics[reasonCode];
    if (
      'category' in value &&
      value.category === expected.category &&
      'phase' in value &&
      value.phase === expected.phase
    )
      return { ...expected, reasonCode };
  }
  return { ...diagnostics.unknown, reasonCode: 'unknown' };
}

function diagnostic(reasonCode: keyof typeof diagnostics): SessionDispatchDiagnostic {
  return { ...diagnostics[reasonCode], reasonCode };
}

export function classifySessionDispatchFailure(error: unknown): SessionDispatchDiagnostic {
  if (error instanceof SessionDispatchConnectionError)
    return retainSessionDispatchDiagnostic(error.sessionDispatchDiagnostic);
  if (error instanceof GatewayClientRequestTimeoutError && error.method === 'connect')
    return diagnostic(error.requestSent ? 'connect-request-timeout' : 'connect-unsent-timeout');
  if (error instanceof GatewayClientRequestError) {
    const details: unknown = error.details;
    if (
      error.code === 'UNAVAILABLE' &&
      details &&
      typeof details === 'object' &&
      'reason' in details &&
      details.reason === 'websocket-upgrade-rejected'
    )
      return diagnostic('websocket-upgrade-rejected');
    switch (error.code) {
      case 'FORBIDDEN':
        return diagnostic('forbidden');
      case 'INVALID_REQUEST':
        return diagnostic('request-invalid');
      case 'UNAVAILABLE':
        return diagnostic('unavailable');
      default:
        return diagnostic('unknown');
    }
  }
  if (error instanceof Error && 'code' in error) {
    switch (error.code) {
      case 'ECONNREFUSED':
        return diagnostic('connection-refused');
      case 'ENOTFOUND':
        return diagnostic('host-not-found');
      case 'ECONNRESET':
        return diagnostic('connection-reset');
      case 'EPIPE':
        return diagnostic('broken-pipe');
      case 'ETIMEDOUT':
        return diagnostic('transport-timeout');
    }
  }
  return diagnostic('unknown');
}

export function sessionDispatchDiagnosticMessage(value: SessionDispatchDiagnostic): string {
  const safe = retainSessionDispatchDiagnostic(value);
  return `Session dispatch connection: category=${safe.category}; phase=${safe.phase}; reason=${safe.reasonCode}.`;
}

export class SessionDispatchConnectionError extends Error {
  readonly sessionDispatchDiagnostic: SessionDispatchDiagnostic;

  constructor(value: SessionDispatchDiagnostic) {
    super(sessionDispatchDiagnosticMessage(value));
    this.sessionDispatchDiagnostic = retainSessionDispatchDiagnostic(value);
  }
}

export function sessionDispatchDeadlineError(): SessionDispatchConnectionError {
  return new SessionDispatchConnectionError(diagnostic('enrollment-deadline'));
}
