import { Type, type Static } from 'typebox';

import {
  decodeResolvableString,
  externalEnvironmentBindingSchema,
  externalResolvableStringSchema,
} from '../../utils/manifest-value-schemas.ts';
import type { EnvironmentBinding, ResolvableString } from '../../utils/manifest-value-types.ts';

export const externalGitHubSectionSchema = Type.Object(
  {
    config: Type.Optional(
      Type.Object(
        {
          'accessible-colors': Type.Optional(
            Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]),
          ),
          'color-labels': Type.Optional(
            Type.Union([Type.Literal('enabled'), Type.Literal('disabled')]),
          ),
          'git-protocol': Type.Optional(Type.Union([Type.Literal('https'), Type.Literal('ssh')])),
          spinner: Type.Optional(Type.Union([Type.Literal('enabled'), Type.Literal('disabled')])),
          telemetry: Type.Optional(Type.Union([Type.Literal('enabled'), Type.Literal('disabled')])),
        },
        { additionalProperties: false },
      ),
    ),
    host: Type.Optional(Type.Literal('github.com')),
    username: Type.Optional(externalResolvableStringSchema),
    token: Type.Optional(externalEnvironmentBindingSchema),
  },
  { additionalProperties: false },
);

type ExternalGitHubSection = Static<typeof externalGitHubSectionSchema>;

export interface GitHubManifestConfiguration {
  config?: Partial<GitHubCliConfiguration>;
  host?: 'github.com';
  token?: EnvironmentBinding;
  username?: ResolvableString;
}

export interface GitHubCliConfiguration {
  accessibleColors: 'enabled' | 'disabled';
  colorLabels: 'enabled' | 'disabled';
  gitProtocol: 'https' | 'ssh';
  spinner: 'enabled' | 'disabled';
  telemetry: 'enabled' | 'disabled';
}

export const defaultGitHubCliConfiguration: GitHubCliConfiguration = {
  accessibleColors: 'disabled',
  colorLabels: 'enabled',
  gitProtocol: 'ssh',
  spinner: 'enabled',
  telemetry: 'disabled',
};

export function resolveGitHubCliConfiguration(
  configuration: GitHubManifestConfiguration,
): GitHubCliConfiguration {
  return { ...defaultGitHubCliConfiguration, ...configuration.config };
}

/** Decode schema-owned GitHub keys without transforming environment-variable names. */
export function decodeGitHubSection(value: ExternalGitHubSection): GitHubManifestConfiguration {
  return {
    ...(value.config
      ? {
          config: {
            ...(value.config['accessible-colors']
              ? { accessibleColors: value.config['accessible-colors'] }
              : {}),
            ...(value.config['color-labels'] ? { colorLabels: value.config['color-labels'] } : {}),
            ...(value.config['git-protocol'] ? { gitProtocol: value.config['git-protocol'] } : {}),
            ...(value.config.spinner ? { spinner: value.config.spinner } : {}),
            ...(value.config.telemetry ? { telemetry: value.config.telemetry } : {}),
          },
        }
      : {}),
    ...(value.host ? { host: value.host } : {}),
    ...(value.token ? { token: value.token } : {}),
    ...(value.username ? { username: decodeResolvableString(value.username) } : {}),
  };
}
