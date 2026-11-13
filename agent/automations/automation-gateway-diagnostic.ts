import providerErrorMessage from '../../utils/provider-error-message.ts';
import { isGatewayClientRequestError } from 'openclaw/plugin-sdk/gateway-runtime';
import gatewayErrorDiagnostic, {
  retainGatewayErrorDiagnostic,
  type GatewayErrorDiagnostic,
} from '../../utils/gateway-error-diagnostic.ts';
import type { AutomationGateway } from './automation-gateway.ts';

export interface AutomationGatewayDiagnostic extends GatewayErrorDiagnostic {
  method: Parameters<AutomationGateway>[0];
  automationId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  nativeRejection?: { message?: string; detailCode?: string };
  reason?:
    | 'agent-unknown'
    | 'agent-session-mismatch'
    | 'session-key-malformed'
    | 'agent-retired'
    | 'parameters-invalid'
    | 'model-not-allowed'
    | 'model-invalid'
    | 'model-runtime-unavailable'
    | 'model-selection-locked'
    | 'runtime-restricted'
    | 'session-key-reserved'
    | 'workspace-invalid'
    | 'model-auth-missing'
    | 'model-catalog-loading'
    | 'unclassified'
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
  ...resolverReasons,
  'model-not-allowed',
  'model-invalid',
  'effort-invalid',
  'effort-unsupported',
  'model-runtime-unavailable',
  'model-selection-locked',
  'runtime-restricted',
  'session-key-reserved',
  'workspace-invalid',
  'unclassified',
] as const;

/** missing method evidence is unknown, never copied from arbitrary upstream text. */
export function retainAutomationGatewayDiagnostic(value: unknown): GatewayErrorDiagnostic & {
  method: AutomationGatewayDiagnostic['method'] | null;
  automationId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  reason?: AutomationGatewayDiagnostic['reason'];
  nativeRejection?: AutomationGatewayDiagnostic['nativeRejection'];
} {
  const input = value && typeof value === 'object' ? value : {};
  const method =
    'method' in input
      ? ((
          [
            'models.list',
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
            : method === 'cron.add'
              ? (['model-auth-missing'] as const)
              : []
        ).find((reason) => reason === input.reason)
      : undefined;
  const catalogLoading =
    diagnostic.category === 'rejected' &&
    diagnostic.gatewayCode === 'UNAVAILABLE' &&
    (method === 'sessions.create' || method === 'sessions.patch') &&
    'reason' in input &&
    input.reason === 'model-catalog-loading';
  const automationId =
    method === 'sessions.create' &&
    'automationId' in input &&
    typeof input.automationId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.automationId) &&
    input.automationId.length <= 128
      ? input.automationId
      : undefined;
  return {
    ...diagnostic,
    ...(reason ? { reason } : catalogLoading ? { reason: 'model-catalog-loading' as const } : {}),
    ...(automationId ? { automationId } : {}),
    ...(diagnostic.gatewayCode === 'UNAVAILABLE' &&
    'retryable' in input &&
    typeof input.retryable === 'boolean'
      ? {
          retryable: input.retryable,
          ...('retryAfterMs' in input &&
          typeof input.retryAfterMs === 'number' &&
          Number.isSafeInteger(input.retryAfterMs) &&
          input.retryAfterMs >= 0
            ? { retryAfterMs: input.retryAfterMs }
            : {}),
        }
      : {}),
    ...(diagnostic.category === 'rejected' && 'nativeRejection' in input
      ? { nativeRejection: rejectionEvidence(input.nativeRejection) }
      : {}),
  };
}

function rejectionEvidence(value: unknown, secrets: readonly string[] = []) {
  if (!value || typeof value !== 'object') return undefined;
  const message =
    'message' in value && typeof value.message === 'string'
      ? providerErrorMessage(
          value.message.replace(/\b(?:params|request|payload)\s*[:=][\s\S]*/giu, '[redacted]'),
          secrets,
        )
      : undefined;
  const detailCode =
    'detailCode' in value &&
    typeof value.detailCode === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(value.detailCode)
      ? value.detailCode
      : undefined;
  return message || detailCode
    ? { ...(message ? { message } : {}), ...(detailCode ? { detailCode } : {}) }
    : undefined;
}

export default function automationGatewayDiagnostic(
  method: Parameters<AutomationGateway>[0],
  error: unknown,
  evidence?: { secrets: readonly string[] },
): AutomationGatewayDiagnostic {
  const diagnostic: AutomationGatewayDiagnostic = { method, ...gatewayErrorDiagnostic(error) };
  if (diagnostic.gatewayCode === 'UNAVAILABLE' && isGatewayClientRequestError(error)) {
    diagnostic.retryable = error.retryable;
    if (error.retryAfterMs !== undefined) diagnostic.retryAfterMs = error.retryAfterMs;
  }
  // cron rejects this before creating a job; INVALID_REQUEST alone is not enough.
  if (
    method === 'cron.add' &&
    diagnostic.category === 'rejected' &&
    diagnostic.gatewayCode === 'INVALID_REQUEST' &&
    error instanceof Error &&
    /^invalid cron\.add params: No route-compatible authentication source is configured for [a-zA-Z0-9][a-zA-Z0-9._-]*\.$/.test(
      error.message,
    )
  )
    diagnostic.reason = 'model-auth-missing';
  // classify only known native rejections; never retain identifiers or raw prose.
  if (
    ['sessions.resolve', 'sessions.create', 'sessions.patch'].includes(method) &&
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
    else if (
      /^Model [^\r\n]+ requires agent harness "[^"\r\n]+", but no enabled plugin provides it\. Install and enable its plugin, restart the Gateway, then select the model again\.$/.test(
        error.message,
      ) ||
      /^(?:A runtime|Runtime "[^"\r\n]+") is not available for [^\r\n]+\. Refresh the model catalog and choose again\.$/.test(
        error.message,
      )
    )
      diagnostic.reason = 'model-runtime-unavailable';
    else if (error.message === 'Model selection is locked for this session.')
      diagnostic.reason = 'model-selection-locked';
    else if (
      error.message === 'Session key namespace is reserved for agent harness-owned sessions.'
    )
      diagnostic.reason = 'session-key-reserved';
    else if (error.message === 'sessions.create cwd must be absolute')
      diagnostic.reason = 'workspace-invalid';
    else if (
      'details' in error &&
      error.details &&
      typeof error.details === 'object' &&
      'code' in error.details &&
      error.details.code === 'AGENT_RUNTIME_RESTRICTED'
    )
      diagnostic.reason = 'runtime-restricted';
    diagnostic.reason ??= 'unclassified';
  }
  if (
    (method === 'sessions.create' || method === 'sessions.patch') &&
    diagnostic.category === 'rejected' &&
    diagnostic.gatewayCode === 'UNAVAILABLE' &&
    error instanceof Error &&
    error.message === 'model catalog is still loading; retry in a few seconds'
  )
    diagnostic.reason = 'model-catalog-loading';
  // Opt-in disposable CI evidence excludes arbitrary details and request payloads.
  if (
    evidence &&
    ['models.list', 'sessions.resolve', 'sessions.create', 'cron.add'].includes(method) &&
    diagnostic.category === 'rejected' &&
    error instanceof Error
  ) {
    const details =
      'details' in error && error.details && typeof error.details === 'object'
        ? error.details
        : undefined;
    diagnostic.nativeRejection = rejectionEvidence(
      {
        message:
          method === 'cron.add'
            ? error.message.replace(/^invalid cron\.add params: /, 'invalid cron.add: ')
            : error.message,
        detailCode: details && 'code' in details ? details.code : undefined,
      },
      evidence.secrets,
    );
  }
  return diagnostic;
}
