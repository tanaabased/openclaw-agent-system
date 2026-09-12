import { parseDocument } from 'yaml';

export type Complexity = 'low' | 'medium' | 'high';
export interface RoutingField<T> {
  status: 'verified' | 'missing' | 'invalid' | 'conflicting' | 'unavailable';
  value?: T;
  source: 'native' | 'body fallback';
}
export interface RoutingMetadata {
  complexity: RoutingField<Complexity>;
  workSize: RoutingField<number>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function field<T>(
  values: unknown[],
  allowed: readonly T[],
  source: RoutingField<T>['source'],
): RoutingField<T> {
  const observed = [
    ...new Set(
      values
        .filter((value) => value !== null && value !== undefined)
        .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : String(value)))
        .filter(Boolean),
    ),
  ];
  if (!observed.length) return { status: 'missing', source };
  if (observed.length > 1) return { status: 'conflicting', source };
  const value = allowed.find((candidate) => String(candidate) === observed[0]);
  return value === undefined
    ? { status: 'invalid', source }
    : { status: 'verified', source, value };
}

const complexities = ['low', 'medium', 'high'] as const;
const sizes = [1, 2, 3, 5, 8, 13, 21] as const;

/** Interpret bounded native observations; field order never settles disagreements. */
export function nativeRoutingMetadata(values: unknown, unavailable = false): RoutingMetadata {
  if (unavailable || !Array.isArray(values)) {
    return {
      complexity: { status: 'unavailable', source: 'native' },
      workSize: { status: 'unavailable', source: 'native' },
    };
  }
  const observations = (name: string) =>
    values.flatMap((item) => {
      const row = record(item);
      const fieldName =
        row.issue_field_name ?? row.name ?? record(row.field).name ?? record(row.issue_field).name;
      if (typeof fieldName !== 'string' || fieldName.trim().toLowerCase() !== name) return [];
      return [
        record(row.single_select_option).name ??
          record(row.value).name ??
          row.value ??
          row.number_value,
      ];
    });
  return {
    complexity: field(observations('complexity'), complexities, 'native'),
    workSize: field(observations('work size'), sizes, 'native'),
  };
}

/** Accept only a visible v2 fallback capsule, never arbitrary issue prose or comments. */
export function routingMetadata(native: RoutingMetadata, body: string): RoutingMetadata {
  const capsules: Record<string, unknown>[] = [];
  let malformed = false;
  const visibleBody = body.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const match of visibleBody.matchAll(/^```(?:yaml|yml)\s*\n([\s\S]*?)^```\s*$/gm)) {
    if (!match[1]!.includes('tanaab/task-metadata/v2')) continue;
    try {
      const document = parseDocument(match[1]!, { uniqueKeys: true });
      if (document.errors.length) throw new Error('invalid capsule');
      const value = record(document.toJS({ maxAliasCount: 0 }));
      if (value.schema !== 'tanaab/task-metadata/v2' || value.mode !== 'fallback') continue;
      capsules.push(record(value.fallback));
    } catch {
      malformed = true;
    }
  }
  const fallback = <T>(key: string, allowed: readonly T[]): RoutingField<T> =>
    malformed
      ? { status: 'invalid', source: 'body fallback' }
      : field(
          capsules.map((capsule) => capsule[key]),
          allowed,
          'body fallback',
        );
  const choose = <T>(current: RoutingField<T>, alternate: RoutingField<T>) =>
    (current.status === 'missing' || current.status === 'unavailable') &&
    alternate.status !== 'missing'
      ? alternate
      : current;
  return {
    complexity: choose(native.complexity, fallback('complexity', complexities)),
    workSize: choose(native.workSize, fallback('work-size', sizes)),
  };
}
