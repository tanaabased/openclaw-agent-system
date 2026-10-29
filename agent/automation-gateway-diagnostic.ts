import gatewayErrorDiagnostic, {
  retainGatewayErrorDiagnostic,
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
    | 'parameters-invalid'
    | 'model-not-allowed'
    | 'model-invalid'
    | 'effort-invalid'
    | 'effort-unsupported';
}

const resolverReasons = [
  'agent-unknown',
  'agent-session-mismatch',
  'session-key-malformed',
  'agent-retired',
  'parameters-invalid',
] as const;
const settingsReasons = [
  'parameters-invalid',
  'model-not-allowed',
  'model-invalid',
  'effort-invalid',
  'effort-unsupported',
] as const;

/** missing method evidence is unknown, never copied from arbitrary upstream text. */
export function retainAutomationGatewayDiagnostic(value: unknown): GatewayErrorDiagnostic & {
  method: AutomationGatewayDiagnostic['method'] | null;
  reason?: AutomationGatewayDiagnostic['reason'];
} {
  const input = value && typeof value === 'object' ? value : {};
  const method =
    'method' in input
      ? ((
          [
            'sessions.resolve',
            'sessions.list',
            'sessions.create',
            'sessions.patch',
            'cron.list',
            'cron.get',
            'cron.add',
            'cron.update',
            'cron.status',
            'cron.run',
            'cron.runs',
          ] as const
        ).find((method) => method === input.method) ?? null)
      : null;
  const diagnostic = { method, ...retainGatewayErrorDiagnostic(input) };
  const reason =
    diagnostic.category === 'rejected' &&
    diagnostic.gatewayCode === 'INVALID_REQUEST' &&
    'reason' in input
      ? (method === 'sessions.resolve'
          ? resolverReasons
          : method === 'sessions.create' || method === 'sessions.patch'
            ? settingsReasons
            : []
        ).find((reason) => reason === input.reason)
      : undefined;
  return { ...diagnostic, ...(reason ? { reason } : {}) };
}

export default function automationGatewayDiagnostic(
  method: Parameters<AutomationGateway>[0],
  error: unknown,
): AutomationGatewayDiagnostic {
  const diagnostic: AutomationGatewayDiagnostic = { method, ...gatewayErrorDiagnostic(error) };
  // classify only known native rejections; never retain identifiers or raw prose.
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
  if (
    (method === 'sessions.create' || method === 'sessions.patch') &&
    diagnostic.category === 'rejected' &&
    diagnostic.gatewayCode === 'INVALID_REQUEST' &&
    error instanceof Error
  ) {
    if (error.message.startsWith(`invalid ${method} params:`))
      diagnostic.reason = 'parameters-invalid';
    else if (/^model not allowed: [^\r\n]+$/.test(error.message))
      diagnostic.reason = 'model-not-allowed';
    else if (/^invalid model: [^\r\n]+$/.test(error.message)) diagnostic.reason = 'model-invalid';
    else if (/^invalid thinkingLevel \(use [^\r\n]+\)$/.test(error.message))
      diagnostic.reason = 'effort-invalid';
    else if (
      /^thinkingLevel "[^"\r\n]+" is not supported for [^\r\n]+ \(use [^\r\n]+\)$/.test(
        error.message,
      )
    )
      diagnostic.reason = 'effort-unsupported';
  }
  return diagnostic;
}
