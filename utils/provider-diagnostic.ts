/** Public provider evidence contains no upstream prose or resource identifiers. */
export interface ProviderDiagnostic {
  provider: '1password' | 'github';
  operation:
    | 'credential-resolve'
    | 'client-create'
    | 'secret-resolve'
    | 'environment-read'
    | 'identity-check'
    | 'api-request';
  classification:
    'missing-credential' | 'authentication' | 'permission' | 'rate-limit' | 'transport' | 'unknown';
  explanation: string;
  httpStatus: number | null;
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
  return {
    provider: provider === 'github' ? 'github' : '1password',
    operation: [
      'credential-resolve',
      'client-create',
      'secret-resolve',
      'environment-read',
      'identity-check',
      'api-request',
    ].includes(operation)
      ? operation
      : 'api-request',
    classification: kind,
    explanation: explanations[kind],
    httpStatus:
      typeof evidence.httpStatus === 'number' &&
      Number.isInteger(evidence.httpStatus) &&
      evidence.httpStatus >= 100 &&
      evidence.httpStatus <= 599
        ? evidence.httpStatus
        : null,
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
