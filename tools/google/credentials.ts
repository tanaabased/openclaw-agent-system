import { createHash } from 'node:crypto';

import AgentSystemToolError from '../../api/error.ts';
import type { ResolvedGoogleConfiguration } from './config-schema.ts';

/** Validate declared material without treating imported identity labels as provider proof. */
export function googleCredentials(
  configuration: ResolvedGoogleConfiguration,
  resolveEnvironment: (name: string) => string | undefined,
) {
  const read = (name: string) => {
    const value = resolveEnvironment(name);
    if (!value || Buffer.byteLength(value) > 65536)
      throw new AgentSystemToolError(
        'credential_unavailable',
        'A declared Google credential binding is missing or exceeds the supported size.',
      );
    return value;
  };
  const clientValue = read(configuration.oauthClient);
  const tokenValue = read(configuration.oauthToken);
  const password = read(configuration.keyringPassword);
  try {
    const decode = (value: string) => {
      if (configuration.credentialEncoding !== 'base64') return value;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
        throw new Error();
      const bytes = Buffer.from(value, 'base64');
      if (bytes.toString('base64') !== value) throw new Error();
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    };
    const clientJSON = decode(clientValue);
    const tokenJSON = decode(tokenValue);
    const client = JSON.parse(clientJSON);
    const oauth = client.installed;
    const token = JSON.parse(tokenJSON);
    if (
      !oauth ||
      typeof oauth.client_id !== 'string' ||
      typeof oauth.client_secret !== 'string' ||
      !oauth.client_id ||
      !oauth.client_secret ||
      typeof token.refresh_token !== 'string' ||
      !token.refresh_token ||
      typeof token.email !== 'string' ||
      token.email.trim().toLowerCase() !== configuration.account
    )
      throw new Error();
    // only Google's standard installed-app endpoints are admitted; do not import cached access tokens.
    if (
      (oauth.auth_uri && oauth.auth_uri !== 'https://accounts.google.com/o/oauth2/auth') ||
      (oauth.token_uri && oauth.token_uri !== 'https://oauth2.googleapis.com/token')
    )
      throw new Error();
    const authorization = {
      email: configuration.account,
      client: 'agent-system',
      refresh_token: token.refresh_token,
      ...(Array.isArray(token.services) &&
      token.services.every((value: unknown) => typeof value === 'string')
        ? { services: token.services }
        : {}),
      ...(Array.isArray(token.scopes) &&
      token.scopes.every((value: unknown) => typeof value === 'string')
        ? { scopes: token.scopes }
        : {}),
    };
    const normalizedClient = JSON.stringify({
      installed: { client_id: oauth.client_id, client_secret: oauth.client_secret },
    });
    const normalizedToken = JSON.stringify(authorization);
    return {
      clientJSON: normalizedClient,
      tokenJSON: normalizedToken,
      password,
      fingerprint: createHash('sha256')
        .update(
          JSON.stringify([configuration.account, normalizedClient, normalizedToken, password]),
        )
        .digest('hex'),
      sensitiveValues: [
        clientValue,
        tokenValue,
        clientJSON,
        tokenJSON,
        normalizedClient,
        normalizedToken,
        password,
        oauth.client_secret,
        token.refresh_token,
        ...(typeof token.access_token === 'string' ? [token.access_token] : []),
      ] as string[],
    };
  } catch {
    throw new AgentSystemToolError(
      'credential_unavailable',
      'Google requires installed-app OAuth client JSON and a matching exported refresh authorization. Check the declared bindings and credential-encoding.',
    );
  }
}
export type GoogleCredentials = ReturnType<typeof googleCredentials>;
