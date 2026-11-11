import type { TSchema } from 'typebox';

/** stored extensions are inert; known values and embedded command contracts remain checked. */
export default function storedDataSchema<T extends TSchema>(
  schema: T,
  strictProperties: readonly string[] = [],
): T {
  const source = schema as TSchema & {
    properties?: Record<string, TSchema>;
    patternProperties?: Record<string, TSchema>;
    additionalProperties?: boolean | TSchema;
    items?: TSchema;
    anyOf?: TSchema[];
    allOf?: TSchema[];
    oneOf?: TSchema[];
  };
  const result = { ...source };
  for (const keyword of ['properties', 'patternProperties'] as const)
    if (source[keyword])
      result[keyword] = Object.fromEntries(
        Object.entries(source[keyword]).map(([key, value]) => [
          key,
          keyword === 'properties' && strictProperties.includes(key)
            ? value
            : storedDataSchema(value, strictProperties),
        ]),
      );
  if (source.properties && source.additionalProperties === false)
    result.additionalProperties = true;
  for (const key of ['items', 'additionalProperties'] as const) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value))
      result[key] = storedDataSchema(value as TSchema, strictProperties);
  }
  for (const key of ['anyOf', 'allOf', 'oneOf'] as const)
    if (Array.isArray(source[key]))
      result[key] = source[key].map((value: TSchema) => storedDataSchema(value, strictProperties));
  return result as T;
}
