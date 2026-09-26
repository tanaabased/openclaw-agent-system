import { Type, type Static } from 'typebox';

import type { AgentSystemManifestValueResolver } from '../../api/types.ts';
import {
  decodeResolvableString,
  externalResolvableStringSchema,
} from '../../manifest/value-schemas.ts';
import type { ResolvableString } from '../../manifest/value-types.ts';

const binding = Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' });
export const externalGoogleSectionSchema = Type.Object(
  {
    account: externalResolvableStringSchema,
    'oauth-client': binding,
    'oauth-token': binding,
    'keyring-password': binding,
  },
  { additionalProperties: false },
);

export interface GoogleConfiguration {
  account: ResolvableString;
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
    account: decodeResolvableString(value.account),
    oauthClient: value['oauth-client'],
    oauthToken: value['oauth-token'],
    keyringPassword: value['keyring-password'],
  };
}

export function resolveGoogleConfiguration(
  configuration: GoogleConfiguration,
  resolver: AgentSystemManifestValueResolver,
): ResolvedGoogleConfiguration {
  const account = resolver.resolve(configuration.account, '/google/account').trim().toLowerCase();
  if (account.includes('\0') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(account))
    throw new Error('Google account must resolve to an email address.');
  return { ...configuration, account };
}
