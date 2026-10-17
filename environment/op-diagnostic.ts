import {
  AuthExpiredError,
  DesktopSessionExpiredError,
  RateLimitExceededError,
} from '@1password/sdk';

import providerErrorMessage from '../utils/provider-error-message.ts';
import { providerDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';

/** SDK 0.5.0 usually retains only a message; do not invent missing HTTP or quota data. */
export default function opDiagnostic(
  error: unknown,
  operation: ProviderDiagnostic['operation'],
  secrets: readonly string[] = [],
): ProviderDiagnostic {
  const source = error instanceof Error ? error : undefined;
  const fields = source as
    (Error & { status?: unknown; statusCode?: unknown; httpStatus?: unknown }) | undefined;
  const structured = [fields?.httpStatus, fields?.statusCode, fields?.status].find(
    (value): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599,
  );
  const message = providerErrorMessage(source?.message, secrets);
  const matched = message?.match(
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?\s*[:=]?\s*)([1-5]\d{2})\b/iu,
  );
  const httpStatus = structured ?? (matched ? Number(matched[1]) : undefined);
  const evidence: Partial<ProviderDiagnostic> = {
    ...(message ? { providerMessage: message } : {}),
    ...(httpStatus === undefined
      ? {}
      : { httpStatus, httpStatusSource: structured === undefined ? 'message' : 'structured' }),
  };
  if (error instanceof RateLimitExceededError)
    return providerDiagnostic('1password', operation, 'rate-limit', {
      ...evidence,
      providerCode: 'RateLimitExceededError',
    });
  if (error instanceof AuthExpiredError || error instanceof DesktopSessionExpiredError)
    return providerDiagnostic('1password', operation, 'authentication', {
      ...evidence,
      providerCode:
        error instanceof AuthExpiredError ? 'AuthExpiredError' : 'DesktopSessionExpiredError',
    });
  return providerDiagnostic('1password', operation, 'unknown', evidence);
}
