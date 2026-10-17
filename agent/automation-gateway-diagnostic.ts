import gatewayErrorDiagnostic, {
  type GatewayErrorDiagnostic,
} from '../utils/gateway-error-diagnostic.ts';
import type { AutomationGateway } from './automation-gateway.ts';

export interface AutomationGatewayDiagnostic extends GatewayErrorDiagnostic {
  method: Parameters<AutomationGateway>[0];
  reason?:
    | 'agent-unknown'
    | 'agent-session-mismatch'
    | 'session-key-malformed'
    | 'agent-retired'
    | 'parameters-invalid';
}

export default function automationGatewayDiagnostic(
  method: Parameters<AutomationGateway>[0],
  error: unknown,
): AutomationGatewayDiagnostic {
  const diagnostic: AutomationGatewayDiagnostic = { method, ...gatewayErrorDiagnostic(error) };
  // Classify only known resolver rejections; never retain their identifiers or raw prose.
  if (
    method === 'sessions.resolve' &&
    diagnostic.category === 'rejected' &&
    diagnostic.gatewayCode === 'INVALID_REQUEST' &&
    error instanceof Error
  ) {
    const message = error.message;
    if (/^Unknown agent id "[^"\r\n]*"$/.test(message)) diagnostic.reason = 'agent-unknown';
    else if (/^agent "[^"\r\n]*" does not match session key agent "[^"\r\n]*"$/.test(message))
      diagnostic.reason = 'agent-session-mismatch';
    else if (/^malformed session key "[^"\r\n]*"$/.test(message))
      diagnostic.reason = 'session-key-malformed';
    else if (/^session key belongs to retired agent "[^"\r\n]*"$/.test(message))
      diagnostic.reason = 'agent-retired';
    else if (message.startsWith('invalid sessions.resolve params:'))
      diagnostic.reason = 'parameters-invalid';
  }
  return diagnostic;
}
