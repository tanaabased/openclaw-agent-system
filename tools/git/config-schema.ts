import { Type, type Static } from 'typebox';

import {
  decodeResolvableString,
  externalResolvableStringSchema,
} from '../../utils/manifest-value-schemas.ts';
import type { ResolvableString } from '../../utils/manifest-value-types.ts';

const externalGitPolicyDecisionSchema = Type.Union([
  Type.Literal('allow'),
  Type.Literal('ask'),
  Type.Literal('deny'),
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
  },
  { additionalProperties: false },
);

type ExternalGitSection = Static<typeof externalGitSectionSchema>;

export type GitPolicyDecision = 'allow' | 'ask' | 'deny';

export interface GitPolicyConfiguration {
  destructive: GitPolicyDecision;
  unknown: GitPolicyDecision;
}

export interface GitManifestConfiguration {
  email?: ResolvableString;
  name?: ResolvableString;
  policy?: Partial<GitPolicyConfiguration>;
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
  return {
    ...(value.email === undefined ? {} : { email: decodeResolvableString(value.email) }),
    ...(value.name === undefined ? {} : { name: decodeResolvableString(value.name) }),
    ...(value.policy === undefined ? {} : { policy: { ...value.policy } }),
  };
}
