export type OpCachePolicy =
  | { mode: 'off'; maxEntries: number }
  | { mode: 'timed'; durationSeconds: number; maxEntries: number }
  | { mode: 'process-lifetime'; maxEntries: number };

export const maximumDurationSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 2000);

/** Read only operator-owned plugin configuration, never manifest environment values. */
export default function resolveOpCachePolicy(value: unknown): OpCachePolicy {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid OP cache policy.');
  }
  const config = value as Record<string, unknown>;
  const mode = config.mode ?? 'timed';
  const maxEntries = config.maxEntries ?? 128;
  if (
    Object.keys(config).some((key) => !['mode', 'durationSeconds', 'maxEntries'].includes(key)) ||
    !Number.isInteger(maxEntries) ||
    Number(maxEntries) < 1 ||
    Number(maxEntries) > 1024
  )
    throw new Error('Invalid OP cache policy.');
  if (mode === 'off' || mode === 'process-lifetime') {
    if (config.durationSeconds !== undefined)
      throw new Error('Only timed OP caching accepts a duration.');
    return { mode, maxEntries: Number(maxEntries) };
  }
  const durationSeconds = config.durationSeconds ?? 300;
  if (
    mode !== 'timed' ||
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > maximumDurationSeconds
  )
    throw new Error('Invalid timed OP cache duration.');
  return { mode, durationSeconds, maxEntries: Number(maxEntries) };
}
