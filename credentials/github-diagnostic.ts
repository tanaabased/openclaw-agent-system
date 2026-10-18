import type { AgentSystemCliResult } from '../api/types.ts';
import githubCredentialRejected from './github-rejection.ts';
import providerErrorMessage from '../utils/provider-error-message.ts';
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
    providerMessage?: string;
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
    providerMessage: input.providerMessage,
  });
}

/** Retain only the CLI error line; never copy response bodies or debug output. */
export function githubCliDiagnostic(
  result: AgentSystemCliResult,
  operation: ProviderDiagnostic['operation'] = 'api-request',
): ProviderDiagnostic {
  const errorLine = result.stderr.match(/^gh: ([^\r\n]+)/mu)?.[1];
  const matchedStatus = errorLine?.match(/\(HTTP ([1-5]\d{2})\)\s*$/u);
  const status = matchedStatus
    ? Number(matchedStatus[1])
    : githubCredentialRejected(result)
      ? 401
      : undefined;
  const diagnostic = githubDiagnostic({ timedOut: result.timedOut, status }, operation);
  const rateLimited =
    status === 403 &&
    /^(?:API rate limit exceeded\b|You have exceeded a secondary rate limit\b)/iu.test(
      errorLine ?? '',
    );
  return providerDiagnostic(
    'github',
    operation,
    rateLimited ? 'rate-limit' : diagnostic.classification,
    {
      ...diagnostic,
      ...(status === undefined ? {} : { httpStatusSource: 'message' }),
      providerMessage: providerErrorMessage(errorLine),
    },
  );
}
