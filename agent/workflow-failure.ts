import { providerDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';

/** Preserve public codes and bounded provider evidence through wrapped runtime failures. */
export default function workflowFailure(error: unknown, fallback: string) {
  let code: string | undefined;
  let diagnostic: ProviderDiagnostic | undefined;
  const seen = new Set<unknown>();
  for (let value = error; value && typeof value === 'object' && !seen.has(value);) {
    seen.add(value);
    if (seen.size > 8) break;
    const entry = value as {
      code?: unknown;
      message?: unknown;
      providerDiagnostic?: ProviderDiagnostic;
      cause?: unknown;
    };
    const candidate = typeof entry.code === 'string' ? entry.code : entry.message;
    if (!code && typeof candidate === 'string' && /^[a-z][a-z0-9-]{0,127}$/u.test(candidate))
      code = candidate;
    const source = entry.providerDiagnostic;
    if (!diagnostic && source && typeof source === 'object')
      diagnostic = providerDiagnostic(
        source.provider,
        source.operation,
        source.classification,
        source,
      );
    value = entry.cause;
  }
  return { code: code ?? fallback, ...(diagnostic ? { providerDiagnostic: diagnostic } : {}) };
}
