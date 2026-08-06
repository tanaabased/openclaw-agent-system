import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  maximumCredentialBytes,
  type CredentialKey,
  type CredentialStore,
  type CredentialStoreProblem,
  type CredentialStoreReadResult,
  type CredentialStoreRemoveResult,
  type CredentialStoreWriteResult,
} from './credential-store.ts';
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const identifierPattern = /^[a-z0-9][a-z0-9-]*$/;

export interface FileCredentialStoreDependencies {
  currentUid?: number;
  rootDir?: string;
}

function problem(
  status: CredentialStoreProblem['status'],
  code: string,
  message: string,
): CredentialStoreProblem {
  return { status, code, message };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function hasPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/** Resolve the cross-platform fallback store without accepting relative configuration roots. */
export function resolveFileCredentialStoreRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return isAbsolute(xdgConfigHome)
      ? join(resolve(xdgConfigHome), 'tanaab', 'agent-system')
      : undefined;
  }

  const home = environment.HOME?.trim();
  return home && isAbsolute(home)
    ? join(resolve(home), '.config', 'tanaab', 'agent-system')
    : undefined;
}

/** Persist credentials in an owner-only, agent-scoped filesystem fallback. */
export default class FileCredentialStore implements CredentialStore {
  readonly id = 'file';
  readonly #currentUid: number | undefined;
  readonly #rootDir: string | undefined;

  constructor(dependencies: FileCredentialStoreDependencies) {
    this.#currentUid = dependencies.currentUid;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
  }

  async read(key: CredentialKey): Promise<CredentialStoreReadResult> {
    const paths = this.#paths(key);
    if (!paths) {
      return problem(
        'unavailable',
        'credential-store-path-unavailable',
        'The file credential store does not have a usable configuration directory.',
      );
    }

    const root = await this.#inspectDirectory(paths.rootDir);
    if (root.status !== 'ready') return root.status === 'missing' ? { status: 'missing' } : root;
    const agent = await this.#inspectDirectory(paths.agentDir);
    if (agent.status !== 'ready') return agent.status === 'missing' ? { status: 'missing' } : agent;

    let handle;
    try {
      handle = await open(paths.credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return { status: 'missing' };
      if (code === 'ELOOP') {
        return problem(
          'unsafe',
          'credential-file-symlink',
          'The credential file may not be a symbolic link.',
        );
      }
      return problem(
        'unavailable',
        'credential-file-unreadable',
        'The credential file could not be opened safely.',
      );
    }

    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return problem(
          'unsafe',
          'credential-file-not-regular',
          'The credential path must be a regular file.',
        );
      }
      if (!hasPrivateMode(stats.mode)) {
        return problem(
          'unsafe',
          'credential-file-permissions',
          'The credential file must not be accessible by group or other users.',
        );
      }
      if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
        return problem(
          'unsafe',
          'credential-file-owner',
          'The credential file must be owned by the current user.',
        );
      }
      if (stats.size > maximumCredentialBytes) {
        return problem(
          'unsafe',
          'credential-file-too-large',
          'The credential file exceeds the supported size limit.',
        );
      }

      const contents = await handle.readFile();
      if (contents.byteLength > maximumCredentialBytes) {
        return problem(
          'unsafe',
          'credential-file-too-large',
          'The credential file exceeds the supported size limit.',
        );
      }
      let value: string;
      try {
        value = new TextDecoder('utf-8', { fatal: true }).decode(contents);
      } catch {
        return problem(
          'unsafe',
          'credential-file-encoding',
          'The credential file must contain valid UTF-8.',
        );
      }
      if (value.trim() === '' || value.includes('\0')) {
        return problem(
          'unsafe',
          'credential-file-value',
          'The credential file does not contain a usable credential.',
        );
      }
      return { status: 'found', value };
    } catch {
      return problem(
        'unavailable',
        'credential-file-unreadable',
        'The credential file could not be read safely.',
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async write(key: CredentialKey, value: string): Promise<CredentialStoreWriteResult> {
    if (
      value.trim() === '' ||
      value.includes('\0') ||
      Buffer.byteLength(value, 'utf8') > maximumCredentialBytes
    ) {
      return problem(
        'unsafe',
        'credential-value-invalid',
        'The supplied credential value is empty, invalid, or too large.',
      );
    }

    const paths = this.#paths(key);
    if (!paths) {
      return problem(
        'unavailable',
        'credential-store-path-unavailable',
        'The file credential store does not have a usable configuration directory.',
      );
    }

    const root = await this.#ensureDirectory(paths.rootDir);
    if (root) return root;
    const agent = await this.#ensureDirectory(paths.agentDir);
    if (agent) return agent;

    const existing = await this.read(key);
    if (existing.status === 'found' && existing.value === value) return { status: 'unchanged' };
    if (existing.status === 'unsafe' || existing.status === 'unavailable') return existing;

    const temporaryPath = join(paths.agentDir, `.${key.credentialId}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        privateFileMode,
      );
      await handle.writeFile(value, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, paths.credentialPath);
      return { status: 'stored' };
    } catch {
      return problem(
        'unavailable',
        'credential-file-write-failed',
        'The credential file could not be written safely.',
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async remove(key: CredentialKey): Promise<CredentialStoreRemoveResult> {
    const existing = await this.read(key);
    if (existing.status !== 'found') return existing;

    const paths = this.#paths(key);
    if (!paths) {
      return problem(
        'unavailable',
        'credential-store-path-unavailable',
        'The file credential store does not have a usable configuration directory.',
      );
    }
    try {
      await unlink(paths.credentialPath);
      return { status: 'removed' };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { status: 'missing' };
      return problem(
        'unavailable',
        'credential-file-remove-failed',
        'The credential file could not be removed.',
      );
    }
  }

  #paths(
    key: CredentialKey,
  ): { agentDir: string; credentialPath: string; rootDir: string } | undefined {
    if (
      !this.#rootDir ||
      !identifierPattern.test(key.agentId) ||
      !identifierPattern.test(key.credentialId)
    ) {
      return undefined;
    }
    const agentDir = join(this.#rootDir, key.agentId);
    return {
      agentDir,
      credentialPath: join(agentDir, `${key.credentialId}-token`),
      rootDir: this.#rootDir,
    };
  }

  async #ensureDirectory(path: string): Promise<CredentialStoreProblem | undefined> {
    try {
      await mkdir(path, { mode: privateDirectoryMode, recursive: true });
    } catch {
      return problem(
        'unavailable',
        'credential-directory-create-failed',
        'A credential-store directory could not be created.',
      );
    }
    const inspected = await this.#inspectDirectory(path);
    if (inspected.status === 'ready') return undefined;
    if (inspected.status === 'missing') {
      return problem(
        'unavailable',
        'credential-directory-create-failed',
        'A credential-store directory could not be created.',
      );
    }
    return inspected;
  }

  async #inspectDirectory(
    path: string,
  ): Promise<CredentialStoreProblem | { status: 'missing' } | { status: 'ready' }> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { status: 'missing' };
      return problem(
        'unavailable',
        'credential-directory-unreadable',
        'A credential-store directory could not be inspected.',
      );
    }
    if (!stats.isDirectory()) {
      return problem(
        'unsafe',
        'credential-directory-not-real',
        'Credential-store directories must be real directories and may not be symbolic links.',
      );
    }
    if (!hasPrivateMode(stats.mode)) {
      return problem(
        'unsafe',
        'credential-directory-permissions',
        'Credential-store directories must not be accessible by group or other users.',
      );
    }
    if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
      return problem(
        'unsafe',
        'credential-directory-owner',
        'Credential-store directories must be owned by the current user.',
      );
    }
    return { status: 'ready' };
  }
}
