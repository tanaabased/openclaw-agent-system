import { Type, type Static } from 'typebox';

import type { EnvironmentSetValue, ResolvableString } from './manifest-value-types.ts';

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

export const externalOpSecretReferenceSchema = Type.Object(
  {
    'from-op': Type.String({
      maxLength: 2048,
      minLength: 1,
      pattern: '^op://[^\\u0000\\r\\n/]+/[^\\u0000\\r\\n/]+/[^\\u0000\\r\\n]+$',
    }),
  },
  { additionalProperties: false },
);

export type ExternalResolvableString = Static<typeof externalResolvableStringSchema>;

/** Decode one schema-owned value while preserving environment-variable names as literal data. */
export function decodeResolvableString(value: ExternalResolvableString): ResolvableString {
  return typeof value === 'string' ? value : { fromEnvironment: value['from-environment'] };
}

export function decodeEnvironmentSetValue(
  value: string | Static<typeof externalOpSecretReferenceSchema>,
): EnvironmentSetValue {
  return typeof value === 'string' ? value : { fromOp: value['from-op'] };
}
