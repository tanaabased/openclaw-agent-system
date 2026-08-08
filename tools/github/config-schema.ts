import { Type, type Static } from 'typebox';

import {
  decodeResolvableString,
  externalEnvironmentBindingSchema,
  externalResolvableStringSchema,
} from '../../utils/manifest-value-schemas.ts';
import type { EnvironmentBinding, ResolvableString } from '../../utils/manifest-value-types.ts';

export const externalGitHubSectionSchema = Type.Object(
  {
    host: Type.Optional(Type.Literal('github.com')),
    username: Type.Optional(externalResolvableStringSchema),
    token: externalEnvironmentBindingSchema,
  },
  { additionalProperties: false },
);

type ExternalGitHubSection = Static<typeof externalGitHubSectionSchema>;

export interface GitHubManifestConfiguration {
  host?: 'github.com';
  token: EnvironmentBinding;
  username?: ResolvableString;
}

/** Decode schema-owned GitHub keys without transforming environment-variable names. */
export function decodeGitHubSection(value: ExternalGitHubSection): GitHubManifestConfiguration {
  return {
    ...(value.host ? { host: value.host } : {}),
    token: value.token,
    ...(value.username ? { username: decodeResolvableString(value.username) } : {}),
  };
}
