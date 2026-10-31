import decodeGitHubV3, {
  githubV3Properties,
  githubLegacyScopeProperties,
  githubRoutingScopeProperties,
  type ExternalGitHubV3,
} from '../channels/github/v3-config-schema.ts';
import { Type, type Static } from 'typebox';

import type { GitHubNotificationsDeclaration } from '../channels/github/workflow-policy.ts';
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
  Type.Object(sharedGitHubProperties, { additionalProperties: false }),
  Type.Object(
    { ...sharedGitHubProperties, ...githubV3Properties, ...githubLegacyScopeProperties },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...sharedGitHubProperties, ...githubV3Properties, ...githubRoutingScopeProperties },
    { additionalProperties: false },
  ),
]);

type ExternalGitHubSection = Static<typeof externalGitHubSectionSchema>;

const githubWorkflowProperties = new Set([
  'project-pickup',
  'schema-version',
  'runtimes',
  'interval-minutes',
  'max-concurrent-items',
  'allowed-repository-owners',
  'routing',
  'issue-assignment',
  'review-request',
]);

/** Identify workflow declarations without mistaking shared GitHub tool settings for one. */
export function hasGitHubWorkflowConfiguration(value: unknown): value is ExternalGitHubV3 {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => githubWorkflowProperties.has(key))
  );
}

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
    ...(hasGitHubWorkflowConfiguration(value) ? { notifications: decodeGitHubV3(value) } : {}),
    ...(value.token ? { token: value.token } : {}),
    ...(value.username ? { username: decodeResolvableString(value.username) } : {}),
  };
}
