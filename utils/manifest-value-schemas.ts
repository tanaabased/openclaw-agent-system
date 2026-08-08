import { Type, type Static } from 'typebox';

import type { ResolvableString } from './manifest-value-types.ts';

export const environmentVariableNameSchema = Type.String({
  minLength: 1,
  pattern: '^[A-Z_][A-Z0-9_]*$',
});

export const externalEnvironmentReferenceSchema = Type.Object(
  {
    'from-environment': environmentVariableNameSchema,
  },
  { additionalProperties: false },
);

export const externalResolvableStringSchema = Type.Union([
  Type.String({ minLength: 1 }),
  externalEnvironmentReferenceSchema,
]);

export const externalEnvironmentBindingSchema = environmentVariableNameSchema;

export type ExternalResolvableString = Static<typeof externalResolvableStringSchema>;

/** Decode one schema-owned value while preserving environment-variable names as literal data. */
export function decodeResolvableString(value: ExternalResolvableString): ResolvableString {
  return typeof value === 'string' ? value : { fromEnvironment: value['from-environment'] };
}
