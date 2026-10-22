import decodeGitHubV3, { githubV3Properties } from '../channels/github/v3-config-schema.ts';
import { Type, type Static } from 'typebox';

import {
  decodeGitHubNotifications,
  externalGitHubNotificationsSchema,
  type GitHubNotificationsDeclaration,
} from '../channels/github/config-schema.ts';
import {
  decodeGitHubToolConfiguration,
  externalGitHubToolSectionProperties,
  type GitHubToolManifestConfiguration,
} from '../tools/github/config-schema.ts';
import {
  decodeResolvableString,
  externalEnvironmentBindingSchema,
  externalResolvableStringSchema,
} from './value-schemas.ts';
import type { EnvironmentBinding, ResolvableString } from './value-types.ts';

const sharedGitHubProperties = {
  ...externalGitHubToolSectionProperties,
  host: Type.Optional(Type.Literal('github.com')),
  username: Type.Optional(externalResolvableStringSchema),
  token: Type.Optional(externalEnvironmentBindingSchema),
};
export const externalGitHubSectionSchema = Type.Union([
  Type.Object(
    { ...sharedGitHubProperties, notifications: Type.Optional(externalGitHubNotificationsSchema) },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...sharedGitHubProperties, ...githubV3Properties },
    { additionalProperties: false },
  ),
]);

type ExternalGitHubSection = Static<typeof externalGitHubSectionSchema>;

export interface GitHubManifestConfiguration extends GitHubToolManifestConfiguration {
  host?: 'github.com';
  notifications?: GitHubNotificationsDeclaration;
  token?: EnvironmentBinding;
  username?: ResolvableString;
}

/** Compose the shared GitHub manifest section from tool and channel fragments. */
export function decodeGitHubSection(value: ExternalGitHubSection): GitHubManifestConfiguration {
  return {
    ...decodeGitHubToolConfiguration(value),
    ...(value.host ? { host: value.host } : {}),
    ...('schema-version' in value
      ? { notifications: decodeGitHubV3(value) }
      : value.notifications
        ? { notifications: decodeGitHubNotifications(value.notifications) }
        : {}),
    ...(value.token ? { token: value.token } : {}),
    ...(value.username ? { username: decodeResolvableString(value.username) } : {}),
  };
}
