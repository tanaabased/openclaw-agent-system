import { createHash } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseDocument, stringify } from 'yaml';

import type {
  GitHubAccountCredential,
  GitHubAccountIdentity,
  GitHubCredentialMaterializer,
} from '../../core/github-account-client.ts';
import PrivateStateFile from '../../core/private-state-file.ts';

const maximumProfileFileBytes = 32 * 1024;

interface OpenClawGitHubProfileFiles {
  directories: string[];
  profileDir: string;
}

export interface OpenClawGitHubProfileValidation extends OpenClawGitHubProfileFiles {
  credentialFingerprint: string;
}

export interface OpenClawGitHubProfileValidator {
  validate(options: OpenClawGitHubProfileValidation): Promise<void>;
}

export class OpenClawGitHubProfileError extends Error {
  override name = 'OpenClawGitHubProfileError';

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseYamlRecord(raw: string, label: string): Record<string, unknown> {
  const document = parseDocument(raw, { prettyErrors: false });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new OpenClawGitHubProfileError(
      'openclaw-github-profile-layout-unsupported',
      `The managed GitHub ${label} does not match the supported OpenClaw profile layout.`,
    );
  }
  const value = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(value)) {
    throw new OpenClawGitHubProfileError(
      'openclaw-github-profile-layout-unsupported',
      `The managed GitHub ${label} does not match the supported OpenClaw profile layout.`,
    );
  }
  return value;
}

/** Own OpenClaw's private GitHub PAT profile file contract. */
export default class OpenClawGitHubProfileAdapter
  implements GitHubCredentialMaterializer, OpenClawGitHubProfileValidator
{
  readonly #currentUid: number | undefined;

  constructor(options: { currentUid?: number } = {}) {
    this.#currentUid = options.currentUid;
  }

  async materialize({
    credential,
    directory,
    identity,
  }: {
    credential: GitHubAccountCredential;
    directory: string;
    identity: GitHubAccountIdentity;
  }): Promise<void> {
    try {
      await writeFile(
        join(directory, 'hosts.yml'),
        stringify({
          [credential.host]: {
            oauth_token: credential.token,
            user: identity.login,
            users: { [identity.login]: { oauth_token: credential.token } },
          },
        }),
        { flag: 'wx', mode: 0o600 },
      );
      await writeFile(join(directory, 'config.yml'), stringify({ version: '1' }), {
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(directory, 0o700);
      await chmod(join(directory, 'hosts.yml'), 0o600);
      await chmod(join(directory, 'config.yml'), 0o600);
    } catch (error) {
      if (error instanceof OpenClawGitHubProfileError) throw error;
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-materialization-failed',
        'The agent-scoped OpenClaw GitHub profile could not be materialized safely.',
        { cause: error },
      );
    }
  }

  async validate({
    credentialFingerprint,
    directories,
    profileDir,
  }: OpenClawGitHubProfileValidation): Promise<void> {
    const hostsRaw = await this.#profileFile(
      directories,
      'managed GitHub hosts file',
      join(profileDir, 'hosts.yml'),
    ).read();
    const configRaw = await this.#profileFile(
      directories,
      'managed GitHub config file',
      join(profileDir, 'config.yml'),
    ).read();
    if (hostsRaw === undefined || configRaw === undefined) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-layout-unsupported',
        'The managed GitHub profile is missing required OpenClaw files.',
      );
    }

    const hosts = parseYamlRecord(hostsRaw, 'hosts file');
    const host = hosts['github.com'];
    const config = parseYamlRecord(configRaw, 'config file');
    if (!isRecord(host) || typeof host.oauth_token !== 'string' || config.version !== '1') {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-layout-unsupported',
        'The managed GitHub profile does not match the supported OpenClaw PAT layout.',
      );
    }
    const storedFingerprint = createHash('sha256').update(host.oauth_token.trim()).digest('hex');
    if (storedFingerprint !== credentialFingerprint) {
      throw new OpenClawGitHubProfileError(
        'openclaw-github-profile-credential-mismatch',
        'The managed GitHub profile credential does not match Agent System.',
      );
    }
  }

  #profileFile(directories: string[], label: string, path: string): PrivateStateFile {
    return new PrivateStateFile({
      ...(this.#currentUid === undefined ? {} : { currentUid: this.#currentUid }),
      directories,
      label,
      maximumBytes: maximumProfileFileBytes,
      path,
    });
  }
}
