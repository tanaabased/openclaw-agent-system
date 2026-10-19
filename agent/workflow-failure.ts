import { providerDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import { RetainedHistoryError } from './retained-history.ts';

/** preserve public codes and bounded provider evidence through wrapped runtime failures. */
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
  return {
    code: code ?? fallback,
    ...(diagnostic ? { providerDiagnostic: diagnostic } : {}),
    ...(error instanceof RetainedHistoryError
      ? { retentionDiagnostic: error.retentionDiagnostic }
      : {}),
  };
}

/** return bounded operation identity without copying prompts, paths, or other request content. */
export function workflowFailureScope(runtime: 'codex' | 'openclaw', route: string, input: unknown) {
  const request = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const actions = new Set([
    'inspect',
    'next',
    'prepare',
    'publish',
    'reconcile',
    'compose',
    'candidate',
    'announce',
    'present',
    'context',
    'result',
    'summary',
    'handoff',
    'report',
    'retry-denied',
    'retry',
    'reset',
    'retire',
    'cancel',
    'start',
    'assess',
    'feedback',
    'delivery',
    'implementation-context',
    'implementation-result',
  ]);
  const action =
    typeof request.action === 'string' && actions.has(request.action) ? request.action : undefined;
  const nested =
    action === 'delivery' && request.delivery && typeof request.delivery === 'object'
      ? (request.delivery as Record<string, unknown>)
      : undefined;
  const operation = nested?.action ?? request.operation;
  return {
    runtime,
    operation: [
      route,
      action,
      typeof operation === 'string' && actions.has(operation) ? operation : undefined,
    ]
      .filter(Boolean)
      .join(':'),
    ...(typeof request.id === 'string' && /^[a-f0-9]{64}$/.test(request.id)
      ? { id: request.id }
      : {}),
    ...(typeof request.eventId === 'string' && /^[a-f0-9]{64}$/.test(request.eventId)
      ? { eventId: request.eventId }
      : {}),
  };
}
