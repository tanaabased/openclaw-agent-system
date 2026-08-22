export interface InterpolatedEnvironmentValue {
  missing: string[];
  references: string[];
  value: string;
}

const environmentReferencePattern = /\$\$|\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;

/** Resolve supported environment references once without evaluating shell syntax. */
export default function interpolateEnvironmentValue(
  input: string,
  lookup: Readonly<Record<string, string | undefined>>,
): InterpolatedEnvironmentValue {
  const missing = new Set<string>();
  const references = new Set<string>();
  const value = input.replace(
    environmentReferencePattern,
    (reference, bracedName: string | undefined, bareName: string | undefined) => {
      if (reference === '$$') return '$';

      const name = bracedName ?? bareName;
      if (!name) return reference;
      references.add(name);
      const resolved = lookup[name];
      if (resolved === undefined) {
        missing.add(name);
        return reference;
      }
      return resolved;
    },
  );

  return { missing: [...missing], references: [...references], value };
}
