import { Type } from 'typebox';

import providerErrorMessage from './provider-error-message.ts';

/** Public provider evidence is bounded and redacted before retention or formatting. */
export interface ProviderDiagnostic {
  provider: '1password' | 'github' | 'git';
  operation:
    | 'credential-resolve'
    | 'client-create'
    | 'secret-resolve'
    | 'environment-read'
    | 'identity-check'
    | 'api-request'
    | 'git-command';
  classification:
    'missing-credential' | 'authentication' | 'permission' | 'rate-limit' | 'transport' | 'unknown';
  explanation: string;
  httpStatus: number | null;
  httpStatusSource?: 'structured' | 'message';
  providerMessage?: string;
  providerCode: 'RateLimitExceededError' | 'AuthExpiredError' | 'DesktopSessionExpiredError' | null;
  retryAfterMs: number | null;
  resetAt: number | null;
  quotaScope: 'token' | 'account' | 'core' | 'search' | 'graphql' | null;
  localBackoffMs: number | null;
}

const explanations: Record<ProviderDiagnostic['classification'], string> = {
  'missing-credential':
    'No credential is available. Configure the declared credential before retrying.',
  authentication: 'The provider rejected authentication. Check the credential before retrying.',
  permission: 'The provider denied access. Check the granted permissions.',
  'rate-limit':
    'The provider is throttling requests. Wait for supplied retry/reset guidance or inspect quota; repeated retries cannot restore allowance.',
  transport:
    'The provider request could not complete. Check connectivity before retrying; do not replay uncertain writes.',
  unknown:
    'The provider failure supplied no supported classification. Upstream details were withheld.',
};

export function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Rebuild the entire allowlist even when evidence crosses a runtime boundary. */
export function providerDiagnostic(
  provider: ProviderDiagnostic['provider'],
  operation: ProviderDiagnostic['operation'],
  classification: ProviderDiagnostic['classification'],
  evidence: Partial<ProviderDiagnostic> = {},
): ProviderDiagnostic {
  const kind = Object.hasOwn(explanations, classification) ? classification : 'unknown';
  const message = providerErrorMessage(evidence.providerMessage);
  const httpStatus =
    typeof evidence.httpStatus === 'number' &&
    Number.isInteger(evidence.httpStatus) &&
    evidence.httpStatus >= 100 &&
    evidence.httpStatus <= 599
      ? evidence.httpStatus
      : null;
  return {
    provider: provider === 'github' || provider === 'git' ? provider : '1password',
    operation: [
      'credential-resolve',
      'client-create',
      'secret-resolve',
      'environment-read',
      'identity-check',
      'api-request',
      'git-command',
    ].includes(operation)
      ? operation
      : 'api-request',
    classification: kind,
    explanation:
      message && kind === 'unknown'
        ? 'The provider failure supplied no supported classification; see the redacted provider message.'
        : explanations[kind],
    ...(message ? { providerMessage: message } : {}),
    ...(httpStatus !== null &&
    (evidence.httpStatusSource === 'structured' || evidence.httpStatusSource === 'message')
      ? { httpStatusSource: evidence.httpStatusSource }
      : {}),
    httpStatus,
    providerCode: [
      'RateLimitExceededError',
      'AuthExpiredError',
      'DesktopSessionExpiredError',
    ].includes(evidence.providerCode ?? '')
      ? evidence.providerCode!
      : null,
    retryAfterMs: safeInteger(evidence.retryAfterMs),
    resetAt:
      safeInteger(evidence.resetAt) !== null && evidence.resetAt! <= 8_640_000_000_000_000
        ? evidence.resetAt!
        : null,
    quotaScope: ['token', 'account', 'core', 'search', 'graphql'].includes(
      evidence.quotaScope ?? '',
    )
      ? evidence.quotaScope!
      : null,
    localBackoffMs: safeInteger(evidence.localBackoffMs),
  };
}

export function formatProviderDiagnostic(value: ProviderDiagnostic): string {
  const safe = providerDiagnostic(value.provider, value.operation, value.classification, value);
  return Object.entries(safe)
    .map(([key, entry]) => `${key}=${JSON.stringify(entry ?? 'unknown')}`)
    .join(' ');
}

export function withProviderDiagnostic(message: string, value?: ProviderDiagnostic): string {
  return value ? `${message} ${formatProviderDiagnostic(value)}` : message;
}

/** bounded provider evidence retained with workflow failures. */
export const providerDiagnosticSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal('github'), Type.Literal('git'), Type.Literal('1password')]),
    operation: Type.Union([
      Type.Literal('credential-resolve'),
      Type.Literal('client-create'),
      Type.Literal('secret-resolve'),
      Type.Literal('environment-read'),
      Type.Literal('identity-check'),
      Type.Literal('api-request'),
      Type.Literal('git-command'),
    ]),
    classification: Type.Union([
      Type.Literal('missing-credential'),
      Type.Literal('authentication'),
      Type.Literal('permission'),
      Type.Literal('rate-limit'),
      Type.Literal('transport'),
      Type.Literal('unknown'),
    ]),
    explanation: Type.String({ maxLength: 4096 }),
    httpStatus: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
    httpStatusSource: Type.Optional(
      Type.Union([Type.Literal('structured'), Type.Literal('message')]),
    ),
    providerMessage: Type.Optional(Type.String({ maxLength: 4096 })),
    providerCode: Type.Union([
      Type.Literal('RateLimitExceededError'),
      Type.Literal('AuthExpiredError'),
      Type.Literal('DesktopSessionExpiredError'),
      Type.Null(),
    ]),
    retryAfterMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    resetAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    quotaScope: Type.Union([
      Type.Literal('token'),
      Type.Literal('account'),
      Type.Literal('core'),
      Type.Literal('search'),
      Type.Literal('graphql'),
      Type.Null(),
    ]),
    localBackoffMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);
