import { Type, type Static } from 'typebox';

import type { AgentSystemManifestValueResolver } from '../../api/types.ts';
import AgentSystemToolError from '../../api/error.ts';
import {
  decodeResolvableString,
  externalResolvableStringSchema,
} from '../../manifest/value-schemas.ts';
import type { ResolvableString } from '../../manifest/value-types.ts';

const binding = Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' });
export const externalGoogleSectionSchema = Type.Object(
  {
    account: Type.Optional(externalResolvableStringSchema),
    'credential-encoding': Type.Optional(
      Type.Union([Type.Literal('json'), Type.Literal('base64')]),
    ),
    'oauth-client': binding,
    'oauth-token': binding,
    'keyring-password': binding,
  },
  { additionalProperties: false },
);

export interface GoogleConfiguration {
  account?: ResolvableString;
  credentialEncoding?: 'json' | 'base64';
  oauthClient: string;
  oauthToken: string;
  keyringPassword: string;
}
export interface ResolvedGoogleConfiguration extends Omit<GoogleConfiguration, 'account'> {
  account: string;
}

export function decodeGoogleConfiguration(
  value: Static<typeof externalGoogleSectionSchema>,
): GoogleConfiguration {
  return {
    ...(value.account === undefined ? {} : { account: decodeResolvableString(value.account) }),
    ...(value['credential-encoding'] === undefined
      ? {}
      : { credentialEncoding: value['credential-encoding'] }),
    oauthClient: value['oauth-client'],
    oauthToken: value['oauth-token'],
    keyringPassword: value['keyring-password'],
  };
}

export function resolveGoogleConfiguration(
  configuration: GoogleConfiguration,
  resolver: AgentSystemManifestValueResolver,
  agentEmail?: ResolvableString,
): ResolvedGoogleConfiguration {
  const declaration = configuration.account ?? agentEmail;
  if (declaration === undefined)
    throw new AgentSystemToolError(
      'configuration_unavailable',
      'Google requires google.account or agent.email.',
    );
  const account = resolver
    .resolve(declaration, configuration.account === undefined ? '/agent/email' : '/google/account')
    .trim()
    .toLowerCase();
  if (account.includes('\0') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(account))
    throw new AgentSystemToolError(
      'configuration_unavailable',
      'Google account must resolve to an email address.',
    );
  return {
    ...configuration,
    account,
    credentialEncoding: configuration.credentialEncoding ?? 'json',
  };
}
