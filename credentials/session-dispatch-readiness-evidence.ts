export const readinessObservationLimit = 16;

type Missing = 'absent' | 'malformed';
type Flag = boolean | Missing;
export interface ReadinessObservation {
  elapsedMs: number;
  path: '/startupz' | '/readyz';
  statusCode: number | null;
  transport:
    | 'none'
    | 'connection-refused'
    | 'connection-reset'
    | 'timeout'
    | 'response-too-large'
    | 'unknown';
  body: 'object' | Missing;
  startupOk: Flag;
  startupStatus: 'starting' | 'started' | 'draining' | Missing;
  ready: Flag;
  pluginReloadFailing: Flag;
  pluginReloadPhase: 'idle' | 'reloading' | 'recovering' | 'failed' | Missing;
}

export interface ReadinessEvidence {
  state: 'observed' | Missing;
  elapsedMs: number | null;
  maxWaitMs: number | null;
  totalObservations: number;
  droppedObservations: number;
  observations: ReadinessObservation[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function choice<T extends string>(
  value: unknown,
  values: readonly T[],
  retained = false,
): T | Missing {
  if (value === undefined || (retained && value === 'absent')) return 'absent';
  return values.includes(value as T) ? (value as T) : 'malformed';
}

function flag(value: unknown, retained = false): Flag {
  return typeof value === 'boolean'
    ? value
    : value === undefined || (retained && value === 'absent')
      ? 'absent'
      : 'malformed';
}

function statusCode(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? (value as number)
    : null;
}

/** project provider data before retention; no arbitrary payload strings cross this boundary. */
export function observeReadiness(
  path: ReadinessObservation['path'],
  elapsedMs: number,
  probe?: { statusCode: number; body: unknown; malformed?: boolean },
  error?: unknown,
): ReadinessObservation {
  const body = object(probe?.body);
  const reload = object(body?.pluginReload);
  const code = object(error)?.code;
  const transport: ReadinessObservation['transport'] = probe
    ? 'none'
    : code === 'ECONNREFUSED'
      ? 'connection-refused'
      : code === 'ECONNRESET'
        ? 'connection-reset'
        : code === 'ETIMEDOUT' || code === 'PROBE_TIMEOUT'
          ? 'timeout'
          : code === 'PROBE_RESPONSE_TOO_LARGE'
            ? 'response-too-large'
            : 'unknown';
  return {
    elapsedMs,
    path,
    statusCode: statusCode(probe?.statusCode),
    transport,
    body: body ? 'object' : probe?.malformed || probe?.body !== undefined ? 'malformed' : 'absent',
    startupOk: flag(body?.ok),
    startupStatus: choice(body?.status, ['starting', 'started', 'draining']),
    ready: flag(body?.ready),
    pluginReloadFailing:
      body?.failing === undefined
        ? 'absent'
        : Array.isArray(body.failing) && body.failing.every((item) => typeof item === 'string')
          ? body.failing.includes('plugin-reload')
          : 'malformed',
    pluginReloadPhase:
      body?.pluginReload !== undefined && !reload
        ? 'malformed'
        : choice(reload?.phase, ['idle', 'reloading', 'recovering', 'failed']),
  };
}

/** rebuild even typed input: lifecycle and cli callers may receive forged nested properties. */
export function retainReadinessEvidence(value: unknown): ReadinessEvidence {
  const raw = object(value);
  const absent: ReadinessEvidence = {
    state: value === undefined ? 'absent' : 'malformed',
    elapsedMs: null,
    maxWaitMs: null,
    totalObservations: 0,
    droppedObservations: 0,
    observations: [],
  };
  if (!raw) return absent;
  if (raw.state === 'absent' || raw.state === 'malformed') return { ...absent, state: raw.state };
  if (
    raw.state !== 'observed' ||
    !nonnegative(raw.elapsedMs) ||
    !nonnegative(raw.maxWaitMs) ||
    !Number.isSafeInteger(raw.totalObservations) ||
    (raw.totalObservations as number) < 0 ||
    !Array.isArray(raw.observations) ||
    raw.observations.length > readinessObservationLimit ||
    raw.observations.length > (raw.totalObservations as number)
  )
    return absent;
  const observations: ReadinessObservation[] = [];
  for (const item of raw.observations) {
    const entry = object(item);
    if (
      !entry ||
      !nonnegative(entry.elapsedMs) ||
      entry.elapsedMs > raw.elapsedMs ||
      entry.elapsedMs < (observations.at(-1)?.elapsedMs ?? 0) ||
      (entry.path !== '/startupz' && entry.path !== '/readyz')
    )
      return absent;
    const transport = choice(
      entry.transport,
      [
        'none',
        'connection-refused',
        'connection-reset',
        'timeout',
        'response-too-large',
        'unknown',
      ] as const,
      true,
    );
    observations.push({
      elapsedMs: entry.elapsedMs,
      path: entry.path,
      statusCode: statusCode(entry.statusCode),
      transport: transport === 'absent' || transport === 'malformed' ? 'unknown' : transport,
      body: choice(entry.body, ['object'], true),
      startupOk: flag(entry.startupOk, true),
      startupStatus: choice(entry.startupStatus, ['starting', 'started', 'draining'], true),
      ready: flag(entry.ready, true),
      pluginReloadFailing: flag(entry.pluginReloadFailing, true),
      pluginReloadPhase: choice(
        entry.pluginReloadPhase,
        ['idle', 'reloading', 'recovering', 'failed'],
        true,
      ),
    });
  }
  return {
    state: 'observed',
    elapsedMs: raw.elapsedMs,
    maxWaitMs: raw.maxWaitMs,
    totalObservations: raw.totalObservations as number,
    droppedObservations: (raw.totalObservations as number) - observations.length,
    observations,
  };
}
