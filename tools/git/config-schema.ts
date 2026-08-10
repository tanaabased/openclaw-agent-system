import { Type, type Static } from 'typebox';

import {
  decodeResolvableString,
  environmentVariableNameSchema,
  externalResolvableStringSchema,
} from '../../utils/manifest-value-schemas.ts';
import type { ResolvableString } from '../../utils/manifest-value-types.ts';

const externalGitPolicyDecisionSchema = Type.Union([
  Type.Literal('allow'),
  Type.Literal('ask'),
  Type.Literal('deny'),
]);

const externalGitPrivateKeySourceSchema = Type.Union([
  Type.Object(
    {
      path: Type.String({
        minLength: 1,
        pattern: '^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$',
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { 'from-environment': environmentVariableNameSchema },
    { additionalProperties: false },
  ),
]);

export const externalGitSectionSchema = Type.Object(
  {
    email: Type.Optional(externalResolvableStringSchema),
    name: Type.Optional(externalResolvableStringSchema),
    policy: Type.Optional(
      Type.Object(
        {
          destructive: Type.Optional(externalGitPolicyDecisionSchema),
          unknown: Type.Optional(externalGitPolicyDecisionSchema),
        },
        { additionalProperties: false },
      ),
    ),
    ssh: Type.Optional(
      Type.Object(
        {
          'private-keys': Type.Union([
            externalGitPrivateKeySourceSchema,
            Type.Array(externalGitPrivateKeySourceSchema, {
              minItems: 1,
              uniqueItems: true,
            }),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type ExternalGitSection = Static<typeof externalGitSectionSchema>;

export type GitPolicyDecision = 'allow' | 'ask' | 'deny';

export interface GitPolicyConfiguration {
  destructive: GitPolicyDecision;
  unknown: GitPolicyDecision;
}

export type GitPrivateKeySource = { path: string } | { fromEnvironment: string };

export interface GitSshConfiguration {
  privateKeys: GitPrivateKeySource[];
}

export interface GitManifestConfiguration {
  email?: ResolvableString;
  name?: ResolvableString;
  policy?: Partial<GitPolicyConfiguration>;
  ssh?: GitSshConfiguration;
}

export interface GitToolConfiguration {
  agent: {
    email?: ResolvableString;
    name?: ResolvableString;
  };
  git: GitManifestConfiguration;
}

export const defaultGitPolicyConfiguration: GitPolicyConfiguration = {
  destructive: 'deny',
  unknown: 'deny',
};

export function resolveGitPolicyConfiguration(
  configuration: GitManifestConfiguration,
): GitPolicyConfiguration {
  return { ...defaultGitPolicyConfiguration, ...configuration.policy };
}

/** Decode schema-owned Git keys without transforming environment-variable names. */
export function decodeGitSection(value: ExternalGitSection): GitManifestConfiguration {
  const privateKeys = value.ssh?.['private-keys'];
  const normalizedPrivateKeys =
    privateKeys === undefined
      ? undefined
      : Array.isArray(privateKeys)
        ? privateKeys
        : [privateKeys];
  return {
    ...(value.email === undefined ? {} : { email: decodeResolvableString(value.email) }),
    ...(value.name === undefined ? {} : { name: decodeResolvableString(value.name) }),
    ...(value.policy === undefined ? {} : { policy: { ...value.policy } }),
    ...(normalizedPrivateKeys === undefined
      ? {}
      : {
          ssh: {
            privateKeys: normalizedPrivateKeys.map((source) =>
              'path' in source
                ? { path: source.path }
                : { fromEnvironment: source['from-environment'] },
            ),
          },
        }),
  };
}
