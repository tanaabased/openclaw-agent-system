export interface MemoryStatus {
  embeddingProbe?: {
    checked?: boolean;
    error?: string;
    ok: boolean;
  };
  status: {
    chunks?: number;
    custom?: Record<string, unknown>;
    fallback?: { from?: string };
    files?: number;
    fts?: { available: boolean; enabled: boolean };
    lastSyncError?: string;
    provider: string;
    requestedProvider?: string;
    vector?: {
      available?: boolean;
      enabled: boolean;
      index?: { state: 'complete' | 'empty' | 'incomplete' | 'unverified' };
      semanticAvailable?: boolean;
      storeAvailable?: boolean;
    };
  };
}

export type MemoryEmbeddingFailure =
  'authentication' | 'billing-or-quota' | 'permission' | 'transport' | 'unknown';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function parseStatus(value: unknown): MemoryStatus['status'] {
  if (!isRecord(value) || typeof value.provider !== 'string') {
    throw new Error('OpenClaw memory status returned an invalid status object.');
  }
  const fts =
    isRecord(value.fts) &&
    typeof value.fts.enabled === 'boolean' &&
    typeof value.fts.available === 'boolean'
      ? { enabled: value.fts.enabled, available: value.fts.available }
      : undefined;
  const vector =
    isRecord(value.vector) && typeof value.vector.enabled === 'boolean'
      ? {
          enabled: value.vector.enabled,
          ...(optionalBoolean(value.vector.available) === undefined
            ? {}
            : { available: optionalBoolean(value.vector.available) }),
          ...(optionalBoolean(value.vector.semanticAvailable) === undefined
            ? {}
            : { semanticAvailable: optionalBoolean(value.vector.semanticAvailable) }),
          ...(optionalBoolean(value.vector.storeAvailable) === undefined
            ? {}
            : { storeAvailable: optionalBoolean(value.vector.storeAvailable) }),
          ...(isRecord(value.vector.index) &&
          ['complete', 'empty', 'incomplete', 'unverified'].includes(
            String(value.vector.index.state),
          )
            ? {
                index: {
                  state: value.vector.index.state as
                    'complete' | 'empty' | 'incomplete' | 'unverified',
                },
              }
            : {}),
        }
      : undefined;
  return {
    provider: value.provider,
    ...(optionalCount(value.files) === undefined ? {} : { files: optionalCount(value.files) }),
    ...(optionalCount(value.chunks) === undefined ? {} : { chunks: optionalCount(value.chunks) }),
    ...(typeof value.requestedProvider === 'string'
      ? { requestedProvider: value.requestedProvider }
      : {}),
    ...(typeof value.lastSyncError === 'string' ? { lastSyncError: value.lastSyncError } : {}),
    ...(fts ? { fts } : {}),
    ...(vector ? { vector } : {}),
    ...(isRecord(value.fallback) && typeof value.fallback.from === 'string'
      ? { fallback: { from: value.fallback.from } }
      : {}),
    ...(isRecord(value.custom) ? { custom: value.custom } : {}),
  };
}

/** Parse the one agent-scoped row emitted by `openclaw memory status --json`. */
export function parseMemoryStatus(stdout: string, agentId: string): MemoryStatus {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('OpenClaw memory status returned invalid JSON.');
  const row = parsed.find(
    (value) => isRecord(value) && value.agentId === agentId && isRecord(value.status),
  );
  if (!isRecord(row)) throw new Error(`OpenClaw memory status omitted agent ${agentId}.`);
  const probe = row.embeddingProbe;
  return {
    status: parseStatus(row.status),
    ...(isRecord(probe) && typeof probe.ok === 'boolean'
      ? {
          embeddingProbe: {
            ok: probe.ok,
            ...(typeof probe.checked === 'boolean' ? { checked: probe.checked } : {}),
            ...(typeof probe.error === 'string' ? { error: probe.error } : {}),
          },
        }
      : {}),
  };
}

/** Reduce provider prose to a stable redacted failure class. */
export function classifyMemoryEmbeddingFailure(error: string | undefined): MemoryEmbeddingFailure {
  const value = error?.toLowerCase() ?? '';
  if (
    /insufficient[_ -]?quota|billing|payment|required|credit balance|quota exceeded/u.test(value)
  ) {
    return 'billing-or-quota';
  }
  if (/unauthorized|invalid[_ -]?(?:api[_ -]?)?key|authentication|\b401\b/u.test(value)) {
    return 'authentication';
  }
  if (/forbidden|permission|\b403\b/u.test(value)) return 'permission';
  if (/timeout|timed out|network|fetch failed|econn|enotfound|socket/u.test(value)) {
    return 'transport';
  }
  return 'unknown';
}

export function memoryIndexState(
  status: MemoryStatus['status'],
): 'complete' | 'empty' | 'incomplete' | 'unverified' | 'mismatched' | 'missing' | undefined {
  const identity = status.custom?.indexIdentity;
  if (isRecord(identity) && (identity.status === 'mismatched' || identity.status === 'missing')) {
    return identity.status;
  }
  return status.vector?.index?.state;
}
