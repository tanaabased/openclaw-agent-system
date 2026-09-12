import type { AgentSystemCliResult } from '../api/types.ts';
import githubCredentialRejected from './github-rejection.ts';
import {
  providerDiagnostic,
  safeInteger,
  type ProviderDiagnostic,
} from '../utils/provider-diagnostic.ts';

/** Classify supplied HTTP evidence, never response messages or command stderr. */
export default function githubDiagnostic(
  input: {
    status?: number;
    timedOut?: boolean;
    remaining?: number;
    resetAt?: number;
    retryAfterMs?: number;
  },
  operation: ProviderDiagnostic['operation'] = 'api-request',
): ProviderDiagnostic {
  const status = input.status;
  const throttled =
    status === 429 ||
    (status === 403 && (input.remaining === 0 || safeInteger(input.retryAfterMs) !== null));
  const classification = throttled
    ? 'rate-limit'
    : status === 401
      ? 'authentication'
      : status === 403
        ? 'permission'
        : input.timedOut || (status !== undefined && status >= 500 && status <= 599)
          ? 'transport'
          : 'unknown';
  return providerDiagnostic('github', operation, classification, {
    httpStatus: status ?? null,
    resetAt: input.resetAt ?? null,
    retryAfterMs: input.retryAfterMs ?? null,
  });
}

/** Reuse the existing CLI authentication-rejection evidence without exposing stderr. */
export function githubCliDiagnostic(
  result: AgentSystemCliResult,
  operation: ProviderDiagnostic['operation'] = 'api-request',
): ProviderDiagnostic {
  return githubDiagnostic(
    { timedOut: result.timedOut, ...(githubCredentialRejected(result) ? { status: 401 } : {}) },
    operation,
  );
}
