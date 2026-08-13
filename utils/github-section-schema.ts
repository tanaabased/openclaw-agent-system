import { Type, type Static } from 'typebox';

import {
  decodeGitHubNotifications,
  externalGitHubNotificationsSchema,
  type GitHubNotificationsConfiguration,
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
} from './manifest-value-schemas.ts';
import type { EnvironmentBinding, ResolvableString } from './manifest-value-types.ts';

export const externalGitHubSectionSchema = Type.Object(
  {
    ...externalGitHubToolSectionProperties,
    host: Type.Optional(Type.Literal('github.com')),
    notifications: Type.Optional(externalGitHubNotificationsSchema),
    username: Type.Optional(externalResolvableStringSchema),
    token: Type.Optional(externalEnvironmentBindingSchema),
  },
  { additionalProperties: false },
);

type ExternalGitHubSection = Static<typeof externalGitHubSectionSchema>;

export interface GitHubManifestConfiguration extends GitHubToolManifestConfiguration {
  host?: 'github.com';
  notifications?: GitHubNotificationsConfiguration;
  token?: EnvironmentBinding;
  username?: ResolvableString;
}

/** Compose the shared GitHub manifest section from tool and channel fragments. */
export function decodeGitHubSection(value: ExternalGitHubSection): GitHubManifestConfiguration {
  return {
    ...decodeGitHubToolConfiguration(value),
    ...(value.host ? { host: value.host } : {}),
    ...(value.notifications
      ? { notifications: decodeGitHubNotifications(value.notifications) }
      : {}),
    ...(value.token ? { token: value.token } : {}),
    ...(value.username ? { username: decodeResolvableString(value.username) } : {}),
  };
}
