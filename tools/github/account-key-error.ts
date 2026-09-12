import type { ProviderDiagnostic } from '../../utils/provider-diagnostic.ts';
/** Identify stable GitHub account-key failures across client, service, and lifecycle boundaries. */
export default class GitHubAccountKeyError extends Error {
  override name = 'GitHubAccountKeyError';

  constructor(
    readonly code: string,
    message: string,
    _options?: ErrorOptions,
    readonly providerDiagnostic?: ProviderDiagnostic,
  ) {
    // Host error formatters traverse causes; retain only the safe provider evidence.
    super(message);
  }
}
