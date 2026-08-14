import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import AgentSystemToolError from '../../lib/tool-error.ts';
import isPathContained from '../../utils/is-path-contained.ts';
import type { GitPrivateKeySource } from './config-schema.ts';

const maximumPrivateKeyBytes = 65_536;

export interface GitPrivateKeySourceContext {
  currentUid?: number;
  homeDirectory?: string;
  resolveEnvironment(name: string): string | undefined;
  workspaceDir: string;
}

export interface GitPrivateKeySourceDependencies {
  canonicalizeDirectory?(path: string): Promise<string>;
  readPrivateKeyFile?(path: string, currentUid?: number): Promise<string>;
}

interface GitPrivateKeyFileMetadata {
  isFile(): boolean;
  mode: number;
  size: number;
  uid: number;
}

function validatePrivateKeyMaterial(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value) > maximumPrivateKeyBytes
  ) {
    throw new Error('invalid private key material');
  }
  return value;
}

/** Decide file safety from metadata without reading or exposing file contents. */
export function isGitPrivateKeyFileSafe(
  stats: GitPrivateKeyFileMetadata,
  currentUid?: number,
): boolean {
  return (
    stats.isFile() &&
    stats.size > 0 &&
    stats.size <= maximumPrivateKeyBytes &&
    (currentUid === undefined || stats.uid === currentUid) &&
    (stats.mode & 0o077) === 0
  );
}

/** Resolve an explicitly declared path without allowing a relative workspace escape. */
export function resolveGitPrivateKeyPath(
  declaredPath: string,
  workspaceDir: string,
  homeDirectory?: string,
): string {
  if (declaredPath === '~' || declaredPath.startsWith('~/')) {
    if (!homeDirectory) throw new Error('home directory is unavailable');
    return resolve(homeDirectory, declaredPath === '~' ? '.' : declaredPath.slice(2));
  }
  if (declaredPath.startsWith('~')) throw new Error('named home paths are unsupported');
  if (isAbsolute(declaredPath)) return resolve(declaredPath);
  const path = resolve(workspaceDir, declaredPath);
  if (!isPathContained(resolve(workspaceDir), path)) {
    throw new Error('relative path escapes workspace');
  }
  return path;
}

/** Read one owner-only regular private-key file without following its final symlink. */
export async function readGitPrivateKeyFile(path: string, currentUid?: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!isGitPrivateKeyFileSafe(stats, currentUid)) throw new Error('unsafe private key file');
    return validatePrivateKeyMaterial(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

/** Resolve only the declared key sources from the completed Agent System environment or disk. */
export async function loadGitPrivateKeySources(
  sources: readonly GitPrivateKeySource[],
  context: GitPrivateKeySourceContext,
  dependencies: GitPrivateKeySourceDependencies = {},
): Promise<string[]> {
  const canonicalizeDirectory = dependencies.canonicalizeDirectory ?? realpath;
  const readPrivateKeyFile = dependencies.readPrivateKeyFile ?? readGitPrivateKeyFile;
  try {
    return await Promise.all(
      sources.map(async (source) => {
        if ('fromEnvironment' in source) {
          const value = context.resolveEnvironment(source.fromEnvironment);
          if (value === undefined) throw new Error('environment value is unavailable');
          return validatePrivateKeyMaterial(value);
        }
        let path = resolveGitPrivateKeyPath(
          source.path,
          context.workspaceDir,
          context.homeDirectory,
        );
        if (!isAbsolute(source.path) && !source.path.startsWith('~')) {
          const [canonicalWorkspace, canonicalParent] = await Promise.all([
            canonicalizeDirectory(context.workspaceDir),
            canonicalizeDirectory(dirname(path)),
          ]);
          if (!isPathContained(canonicalWorkspace, canonicalParent)) {
            throw new Error('relative path escapes workspace through a symlink');
          }
          path = join(canonicalParent, basename(path));
        }
        return readPrivateKeyFile(path, context.currentUid);
      }),
    );
  } catch {
    throw new AgentSystemToolError(
      'credential_unavailable',
      'A configured Git SSH private key is unavailable or unsafe.',
    );
  }
}
