import { isDeepStrictEqual } from 'node:util';

export const stateSnapshotConflictCode = 'private-state-snapshot-conflict';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keyed(value: unknown[]): value is Array<Record<string, unknown> & { id: string }> {
  return (
    value.every((entry) => object(entry) && typeof entry.id === 'string') &&
    new Set(value.map((entry) => (entry as { id: string }).id)).size === value.length
  );
}

/** merge independent edits; concurrent insertions are reservations, never interchangeable. */
export default function mergeStateSnapshot(
  before: unknown,
  proposed: unknown,
  current: unknown,
): unknown {
  if (isDeepStrictEqual(before, proposed)) return structuredClone(current);
  if (isDeepStrictEqual(before, current)) return structuredClone(proposed);
  if (
    before !== undefined &&
    !object(before) &&
    !Array.isArray(before) &&
    !(before === false && proposed === true) &&
    isDeepStrictEqual(proposed, current)
  )
    return structuredClone(current);
  if (object(before) && object(proposed) && object(current)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(proposed),
      ...Object.keys(current),
    ])) {
      const value = mergeStateSnapshot(before[key], proposed[key], current[key]);
      if (value !== undefined)
        Object.defineProperty(result, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    return result;
  }
  if (
    Array.isArray(before) &&
    Array.isArray(proposed) &&
    Array.isArray(current) &&
    keyed(before) &&
    keyed(proposed) &&
    keyed(current)
  ) {
    const previous = new Map(before.map((entry) => [entry.id, entry]));
    const desired = new Map(proposed.map((entry) => [entry.id, entry]));
    const latest = new Map(current.map((entry) => [entry.id, entry]));
    return [...new Set([...current.map((entry) => entry.id), ...proposed.map((entry) => entry.id)])]
      .map((id) => mergeStateSnapshot(previous.get(id), desired.get(id), latest.get(id)))
      .filter((entry) => entry !== undefined);
  }
  throw Object.assign(new Error(stateSnapshotConflictCode), { code: stateSnapshotConflictCode });
}

/** refresh a working snapshot while preserving references retained by its operation. */
export function refreshStateSnapshot(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
    const old = target[key];
    if (object(old) && object(value)) refreshStateSnapshot(old, value);
    else if (Array.isArray(old) && Array.isArray(value) && keyed(old) && keyed(value)) {
      const retained = new Map(old.map((entry) => [entry.id, entry]));
      old.splice(
        0,
        old.length,
        ...value.map((entry) => {
          const existing = retained.get(entry.id);
          if (!existing) return structuredClone(entry);
          refreshStateSnapshot(existing, entry);
          return existing;
        }),
      );
    } else
      Object.defineProperty(target, key, {
        value: structuredClone(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
}
