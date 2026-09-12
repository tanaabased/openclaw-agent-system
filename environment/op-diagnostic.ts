import {
  AuthExpiredError,
  DesktopSessionExpiredError,
  RateLimitExceededError,
} from '@1password/sdk';

import { providerDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';

/** SDK 0.5.0 supplies typed errors, but no structured status, reset, or quota scope. */
export default function opDiagnostic(
  error: unknown,
  operation: ProviderDiagnostic['operation'],
): ProviderDiagnostic {
  if (error instanceof RateLimitExceededError)
    return providerDiagnostic('1password', operation, 'rate-limit', {
      providerCode: 'RateLimitExceededError',
    });
  if (error instanceof AuthExpiredError || error instanceof DesktopSessionExpiredError)
    return providerDiagnostic('1password', operation, 'authentication', {
      providerCode:
        error instanceof AuthExpiredError ? 'AuthExpiredError' : 'DesktopSessionExpiredError',
    });
  return providerDiagnostic('1password', operation, 'unknown');
}
