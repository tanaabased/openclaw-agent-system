import { Type, type Static } from 'typebox';

import {
  decodeResolvableString,
  environmentVariableNameSchema,
  externalEnvironmentBindingSchema,
  externalResolvableStringSchema,
} from '../../utils/manifest-value-schemas.ts';
import type { EnvironmentBinding, ResolvableString } from '../../utils/manifest-value-types.ts';

const externalGitPolicyDecisionSchema = Type.Union([Type.Literal('allow'), Type.Literal('deny')]);

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

const externalGitAllowedSignersFileSchema = Type.String({
  maxLength: 4096,
  minLength: 1,
  pattern:
    '^(?![A-Za-z]:[\\\\/])(?![\\/~])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$))[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$',
});

const externalGitWorktreePathSchema = Type.String({
  maxLength: 4096,
  minLength: 1,
  pattern: '^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$',
});

const externalGitRepositoryIdSchema = Type.String({
  maxLength: 256,
  minLength: 1,
  pattern: '^(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$',
});

export const externalGitSectionSchema = Type.Object(
  {
    email: Type.Optional(externalResolvableStringSchema),
    extensions: Type.Optional(
      Type.Record(
        Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$' }),
        externalGitPolicyDecisionSchema,
        { additionalProperties: false },
      ),
    ),
    name: Type.Optional(externalResolvableStringSchema),
    policy: Type.Optional(
      Type.Object(
        {
          delete: Type.Optional(externalGitPolicyDecisionSchema),
          discard: Type.Optional(externalGitPolicyDecisionSchema),
          force: Type.Optional(externalGitPolicyDecisionSchema),
          rewrite: Type.Optional(externalGitPolicyDecisionSchema),
          unknown: Type.Optional(externalGitPolicyDecisionSchema),
        },
        { additionalProperties: false },
      ),
    ),
    signing: Type.Optional(
      Type.Object(
        {
          'allowed-signers-file': Type.Optional(externalGitAllowedSignersFileSchema),
          key: externalEnvironmentBindingSchema,
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
    worktrees: Type.Optional(
      Type.Object(
        {
          repositories: Type.Optional(
            Type.Object(
              {
                local: Type.Optional(
                  Type.Record(externalGitRepositoryIdSchema, externalGitWorktreePathSchema, {
                    additionalProperties: false,
                  }),
                ),
                root: Type.Optional(externalGitWorktreePathSchema),
              },
              { additionalProperties: false },
            ),
          ),
          root: Type.Optional(externalGitWorktreePathSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type ExternalGitSection = Static<typeof externalGitSectionSchema>;

export type GitPolicyDecision = 'allow' | 'deny';

export interface GitPolicyConfiguration {
  delete: GitPolicyDecision;
  discard: GitPolicyDecision;
  force: GitPolicyDecision;
  rewrite: GitPolicyDecision;
  unknown: GitPolicyDecision;
}

export type GitPrivateKeySource = { path: string } | { fromEnvironment: string };

export interface GitSshConfiguration {
  privateKeys: GitPrivateKeySource[];
}

export interface GitSigningConfiguration {
  allowedSignersFile?: string;
  key: EnvironmentBinding;
}

export interface GitWorktreeConfiguration {
  repositories?: {
    local?: Record<string, string>;
    root?: string;
  };
  root?: string;
}

export interface GitManifestConfiguration {
  email?: ResolvableString;
  extensions?: Record<string, GitPolicyDecision>;
  name?: ResolvableString;
  policy?: Partial<GitPolicyConfiguration>;
  signing?: GitSigningConfiguration;
  ssh?: GitSshConfiguration;
  worktrees?: GitWorktreeConfiguration;
}

export interface GitToolConfiguration {
  agent: {
    email?: ResolvableString;
    name?: ResolvableString;
  };
  git: GitManifestConfiguration;
}

export const defaultGitPolicyConfiguration: GitPolicyConfiguration = {
  delete: 'deny',
  discard: 'deny',
  force: 'deny',
  rewrite: 'deny',
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
    ...(value.extensions === undefined ? {} : { extensions: { ...value.extensions } }),
    ...(value.name === undefined ? {} : { name: decodeResolvableString(value.name) }),
    ...(value.policy === undefined ? {} : { policy: { ...value.policy } }),
    ...(value.signing === undefined
      ? {}
      : {
          signing: {
            key: value.signing.key,
            ...(value.signing['allowed-signers-file'] === undefined
              ? {}
              : { allowedSignersFile: value.signing['allowed-signers-file'] }),
          },
        }),
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
    ...(value.worktrees === undefined
      ? {}
      : {
          worktrees: {
            ...(value.worktrees.repositories === undefined
              ? {}
              : {
                  repositories: {
                    ...(value.worktrees.repositories.local === undefined
                      ? {}
                      : { local: { ...value.worktrees.repositories.local } }),
                    ...(value.worktrees.repositories.root === undefined
                      ? {}
                      : { root: value.worktrees.repositories.root }),
                  },
                }),
            ...(value.worktrees.root === undefined ? {} : { root: value.worktrees.root }),
          },
        }),
  };
}
