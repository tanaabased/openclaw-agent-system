import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentSystemCliResult, AgentSystemCliRunRequest } from '../api/types.ts';
import { googleCredentials } from '../tools/google/credentials.ts';
import type { ResolvedGoogleConfiguration } from '../tools/google/config-schema.ts';

export const googleConfiguration: ResolvedGoogleConfiguration = {
  account: 'one@example.com',
  oauthClient: 'CLIENT',
  oauthToken: 'TOKEN',
  keyringPassword: 'PASSWORD',
};
export const googleValues = {
  CLIENT: JSON.stringify({ installed: { client_id: 'client-id', client_secret: 'client-secret' } }),
  TOKEN: JSON.stringify({
    email: 'one@example.com',
    refresh_token: 'refresh-secret',
    services: ['gmail'],
    scopes: ['https://www.googleapis.com/auth/userinfo.email'],
  }),
  PASSWORD: 'keyring-secret',
};
export function material(
  configuration = googleConfiguration,
  values: Record<string, string> = googleValues,
) {
  return googleCredentials(configuration, (name) => values[name]);
}
export function result(stdout = '', exitCode = 0, stderr = ''): AgentSystemCliResult {
  return { exitCode, stdout, stderr, timedOut: false, truncated: false };
}

export function fakeGoogle(
  requests: AgentSystemCliRunRequest[] = [],
  options: { account?: string; exitCode?: number; version?: string } = {},
) {
  return async (request: AgentSystemCliRunRequest) => {
    requests.push(request);
    if (request.argv.includes('--version')) return result(options.version ?? 'v0.42.0 (test)');
    const data = request.environment.GOG_DATA_DIR!;
    if (request.argv.includes('credentials')) {
      await mkdir(join(data, 'keyring'), { mode: 0o700 });
      await writeFile(join(data, 'credentials.json'), request.stdin!, { mode: 0o600 });
      return result('{}');
    }
    if (request.argv.includes('import')) {
      await writeFile(join(data, 'keyring', 'authorization'), request.stdin!, { mode: 0o600 });
      return result('{}');
    }
    if (request.argv.includes('oauth2.userinfo.get'))
      return result(
        JSON.stringify({
          email:
            options.account ??
            request.argv.find((value) => value.startsWith('--account='))!.slice(10),
          verified_email: true,
        }),
        options.exitCode ?? 0,
      );
    return result('{}');
  };
}
