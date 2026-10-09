export interface ManifestSource {
  path: string;
  fieldPath: string;
}

export interface ManifestDocument {
  path: string;
  value: unknown;
}

export type ManifestSources = Record<string, ManifestSource>;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childPath(parent: string, key: string): string {
  return `${parent}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
}

/** merge mappings without mutation; arrays, scalars, and null replace their inherited value. */
export default function mergeManifestDocuments(
  base: ManifestDocument,
  overlay?: ManifestDocument,
): { value: unknown; sources: ManifestSources } {
  const sources: ManifestSources = {};
  function copy(value: unknown, source: string, fieldPath: string): unknown {
    sources[fieldPath] = { path: source, fieldPath };
    if (Array.isArray(value))
      return value.map((item, index) => copy(item, source, childPath(fieldPath, String(index))));
    if (isMapping(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          copy(item, source, childPath(fieldPath, key)),
        ]),
      );
    return value;
  }
  function merge(inherited: unknown, local: unknown, fieldPath: string): unknown {
    if (!isMapping(inherited) || !isMapping(local)) return copy(local, overlay!.path, fieldPath);
    sources[fieldPath] = { path: base.path, fieldPath };
    return Object.fromEntries(
      [...new Set([...Object.keys(inherited), ...Object.keys(local)])].map((key) => [
        key,
        Object.hasOwn(local, key)
          ? merge(
              Object.hasOwn(inherited, key) ? inherited[key] : undefined,
              local[key],
              childPath(fieldPath, key),
            )
          : copy(inherited[key], base.path, childPath(fieldPath, key)),
      ]),
    );
  }
  return {
    value: overlay ? merge(base.value, overlay.value, '') : copy(base.value, base.path, ''),
    sources,
  };
}

/** attribute structural diagnostics to their nearest effective declaration. */
export function manifestSourceForField(
  sources: ManifestSources,
  fieldPath: string,
): ManifestSource | undefined {
  let pointer = fieldPath;
  while (!Object.hasOwn(sources, pointer)) {
    if (!pointer) return undefined;
    pointer = pointer.slice(0, pointer.lastIndexOf('/'));
  }
  return sources[pointer];
}
