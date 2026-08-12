import { Type, type Static } from 'typebox';

import {
  decodeResolvableString,
  externalEnvironmentBindingSchema,
  externalResolvableStringSchema,
} from '../../utils/manifest-value-schemas.ts';
import type { EnvironmentBinding, ResolvableString } from '../../utils/manifest-value-types.ts';

const externalGitHubKeyValueSchema = Type.String({
  minLength: 1,
  pattern: '^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$',
});
const externalGitHubKeyTitleSchema = Type.String({
  maxLength: 255,
  minLength: 1,
  pattern: '^.*\\S.*$',
});
const externalGitHubKeySourceSchema = Type.Union([
  externalGitHubKeyValueSchema,
  Type.Object(
    {
      key: externalGitHubKeyValueSchema,
      title: Type.Optional(externalGitHubKeyTitleSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      path: externalGitHubKeyValueSchema,
      title: Type.Optional(externalGitHubKeyTitleSchema),
    },
    { additionalProperties: false },
  ),
]);
const externalGitHubKeySourcesSchema = Type.Union([
  externalGitHubKeySourceSchema,
  Type.Array(externalGitHubKeySourceSchema, { minItems: 1 }),
]);
const externalGitHubPolicyDecisionSchema = Type.Union([
  Type.Literal('allow'),
  Type.Literal('deny'),
]);

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
    policy: Type.Optional(
      Type.Object(
        {
          admin: Type.Optional(externalGitHubPolicyDecisionSchema),
          destructive: Type.Optional(externalGitHubPolicyDecisionSchema),
          unknown: Type.Optional(externalGitHubPolicyDecisionSchema),
        },
        { additionalProperties: false },
      ),
    ),
    'ssh-keys': Type.Optional(externalGitHubKeySourcesSchema),
    'ssh-signing-keys': Type.Optional(externalGitHubKeySourcesSchema),
    username: Type.Optional(externalResolvableStringSchema),
    token: Type.Optional(externalEnvironmentBindingSchema),
  },
  { additionalProperties: false },
);

type ExternalGitHubSection = Static<typeof externalGitHubSectionSchema>;

export type GitHubPublicKeySource =
  | { source: string; type: 'auto'; title?: string }
  | { source: string; type: 'key'; title?: string }
  | { source: string; type: 'path'; title?: string };

export interface GitHubManifestConfiguration {
  config?: Partial<GitHubCliConfiguration>;
  host?: 'github.com';
  policy?: Partial<GitHubPolicyConfiguration>;
  sshKeys?: GitHubPublicKeySource[];
  sshSigningKeys?: GitHubPublicKeySource[];
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

export type GitHubPolicyDecision = 'allow' | 'deny';

export interface GitHubPolicyConfiguration {
  admin: GitHubPolicyDecision;
  destructive: GitHubPolicyDecision;
  unknown: GitHubPolicyDecision;
}

export const defaultGitHubCliConfiguration: GitHubCliConfiguration = {
  accessibleColors: 'disabled',
  colorLabels: 'enabled',
  gitProtocol: 'ssh',
  spinner: 'enabled',
  telemetry: 'disabled',
};

export const defaultGitHubPolicyConfiguration: GitHubPolicyConfiguration = {
  admin: 'deny',
  destructive: 'deny',
  unknown: 'deny',
};

export function resolveGitHubCliConfiguration(
  configuration: GitHubManifestConfiguration,
): GitHubCliConfiguration {
  return { ...defaultGitHubCliConfiguration, ...configuration.config };
}

export function resolveGitHubPolicyConfiguration(
  configuration: GitHubManifestConfiguration,
): GitHubPolicyConfiguration {
  return { ...defaultGitHubPolicyConfiguration, ...configuration.policy };
}

/** Decode schema-owned GitHub keys without transforming environment-variable names. */
export function decodeGitHubSection(value: ExternalGitHubSection): GitHubManifestConfiguration {
  const decodeKeySources = (
    sources: NonNullable<ExternalGitHubSection['ssh-keys']>,
  ): GitHubPublicKeySource[] =>
    (Array.isArray(sources) ? sources : [sources]).map((source) =>
      typeof source === 'string'
        ? { source, type: 'auto' }
        : 'key' in source
          ? {
              source: source.key,
              type: 'key',
              ...(source.title === undefined ? {} : { title: source.title }),
            }
          : {
              source: source.path,
              type: 'path',
              ...(source.title === undefined ? {} : { title: source.title }),
            },
    );

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
    ...(value.policy ? { policy: { ...value.policy } } : {}),
    ...(value['ssh-keys'] ? { sshKeys: decodeKeySources(value['ssh-keys']) } : {}),
    ...(value['ssh-signing-keys']
      ? { sshSigningKeys: decodeKeySources(value['ssh-signing-keys']) }
      : {}),
    ...(value.token ? { token: value.token } : {}),
    ...(value.username ? { username: decodeResolvableString(value.username) } : {}),
  };
}
