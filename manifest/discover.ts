import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { maximumManifestBytes, readManifestBytes } from './read-document.ts';
import type { ManifestDiagnostic } from './types.ts';

export { maximumManifestBytes } from './read-document.ts';

interface MissingManifestCandidate {
  status: 'missing';
  path: string;
  fingerprint: string;
}

interface InvalidManifestCandidate {
  status: 'invalid';
  path: string;
  fingerprint: string;
  diagnostics: ManifestDiagnostic[];
}

interface ReadableManifestCandidate {
  status: 'readable';
  path: string;
  fingerprint: string;
}

export type ManifestCandidate =
  MissingManifestCandidate | InvalidManifestCandidate | ReadableManifestCandidate;

export interface ManifestDiscovery {
  workspaceDir: string;
  fingerprint: string;
  selected?: ManifestCandidate;
  overlay?: ManifestCandidate;
  ignoredPath?: string;
  diagnostics: ManifestDiagnostic[];
}

function failure(
  code: string,
  message: string,
  path: string,
  fingerprint: string,
): InvalidManifestCandidate {
  return {
    status: 'invalid',
    path,
    fingerprint,
    diagnostics: [{ code, message, severity: 'error' }],
  };
}

async function inspectCandidate(path: string, includeContents = false): Promise<ManifestCandidate> {
  try {
    const stats = await lstat(path);
    const fingerprint = [
      stats.dev,
      stats.ino,
      stats.mode,
      stats.size,
      stats.mtimeMs,
      stats.ctimeMs,
    ].join(':');

    if (!stats.isFile()) {
      return failure(
        'manifest-not-regular-file',
        'The manifest path must be a regular file and may not be a symbolic link.',
        path,
        `invalid:${fingerprint}`,
      );
    }

    if (stats.size > maximumManifestBytes) {
      return failure(
        'manifest-too-large',
        `The manifest exceeds the ${maximumManifestBytes}-byte size limit.`,
        path,
        `invalid:${fingerprint}`,
      );
    }

    let contentFingerprint = '';
    if (includeContents) {
      const file = await readManifestBytes(path);
      if (file.status === 'invalid')
        return {
          status: 'invalid',
          path,
          fingerprint: `unreadable:${fingerprint}`,
          diagnostics: file.diagnostics,
        };
      contentFingerprint = `:${createHash('sha256').update(file.contents).digest('hex')}`;
    }
    return { status: 'readable', path, fingerprint: `file:${fingerprint}${contentFingerprint}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', path, fingerprint: 'missing' };
    }

    return failure(
      'manifest-stat-failed',
      'The manifest path could not be inspected.',
      path,
      `error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`,
    );
  }
}

async function inspectPreferredCandidate(path: string): Promise<ManifestCandidate> {
  try {
    const stats = await lstat(dirname(path));
    const directoryFingerprint = [
      stats.dev,
      stats.ino,
      stats.mode,
      stats.mtimeMs,
      stats.ctimeMs,
    ].join(':');
    if (!stats.isDirectory()) {
      return failure(
        'manifest-directory-not-real',
        'The .agent-system path must be a real directory and may not be a symbolic link.',
        path,
        `invalid-directory:${directoryFingerprint}`,
      );
    }

    const candidate = await inspectCandidate(path);
    return { ...candidate, fingerprint: `${directoryFingerprint}:${candidate.fingerprint}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', path, fingerprint: 'missing-directory' };
    }

    return failure(
      'manifest-stat-failed',
      'The .agent-system directory could not be inspected.',
      path,
      `directory-error:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`,
    );
  }
}

/** discover exactly one workspace manifest and its optional sibling overlay without following symlinks. */
export default async function discoverManifest(workspaceDir: string): Promise<ManifestDiscovery> {
  const normalizedWorkspaceDir = resolve(workspaceDir);
  const preferredPath = join(normalizedWorkspaceDir, '.agent-system', 'agent.yaml');
  const shorthandPath = join(normalizedWorkspaceDir, 'agent.yaml');
  const [preferred, shorthand] = await Promise.all([
    inspectPreferredCandidate(preferredPath),
    inspectCandidate(shorthandPath),
  ]);
  const preferredExists = preferred.status !== 'missing';
  const shorthandExists = shorthand.status !== 'missing';
  const selected = preferredExists ? preferred : shorthandExists ? shorthand : undefined;
  const overlay =
    selected?.status === 'readable'
      ? await inspectCandidate(join(dirname(selected.path), 'agent.local.yaml'), true)
      : undefined;
  const ignoredPath = preferredExists && shorthandExists ? shorthand.path : undefined;
  const diagnostics: ManifestDiagnostic[] = [];

  if (ignoredPath) {
    diagnostics.push({
      code: 'manifest-shadowed',
      message: 'The root agent.yaml is ignored because .agent-system/agent.yaml exists.',
      severity: 'warning',
    });
  }

  if (selected?.status === 'invalid') diagnostics.push(...selected.diagnostics);
  if (overlay?.status === 'invalid')
    diagnostics.push(
      ...overlay.diagnostics.map((diagnostic) => ({ ...diagnostic, sourcePath: overlay.path })),
    );

  return {
    workspaceDir: normalizedWorkspaceDir,
    fingerprint: `${preferred.fingerprint}|${shorthand.fingerprint}|${overlay?.fingerprint ?? 'no-base'}`,
    selected,
    overlay,
    ignoredPath,
    diagnostics,
  };
}

/** Find the nearest manifest at or above a command working directory. */
export async function discoverManifestFromDirectory(
  commandDirectory: string,
): Promise<ManifestDiscovery> {
  const normalizedCommandDirectory = resolve(commandDirectory);
  let currentDirectory = normalizedCommandDirectory;

  while (true) {
    // A manifest inside the reserved directory belongs to its parent workspace.
    if (basename(currentDirectory) === '.agent-system') {
      const parentDirectory = dirname(currentDirectory);
      if (parentDirectory === currentDirectory) break;
      currentDirectory = parentDirectory;
      continue;
    }
    const discovery = await discoverManifest(currentDirectory);
    if (discovery.selected) return discovery;
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) break;
    currentDirectory = parentDirectory;
  }

  return discoverManifest(normalizedCommandDirectory);
}
