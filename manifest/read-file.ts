import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import isPathContained from '../utils/is-path-contained.ts';
import { maximumManifestBytes } from './discover.ts';
import type { ManifestDiagnostic } from './types.ts';

export interface ManifestFileDependency {
  path: string;
  fingerprint: string;
}

/** read a bounded local reference, relative to its containing file, within the workspace. */
export default async function readManifestFile(
  reference: string,
  manifestPath: string,
  workspaceDir: string,
  fieldPath: string,
  codePrefix: string,
): Promise<
  | { status: 'valid'; path: string; fingerprint: string; contents: Buffer; source: string }
  | { status: 'invalid'; path?: string; diagnostics: ManifestDiagnostic[] }
> {
  const failure = (suffix: string, detail: string, path?: string) => ({
    status: 'invalid' as const,
    ...(path === undefined ? {} : { path }),
    diagnostics: [
      {
        code: `${codePrefix}-${suffix}`,
        fieldPath: `${fieldPath}/file`,
        message: `Referenced file ${JSON.stringify(reference)} ${detail}`,
        severity: 'error' as const,
      },
    ],
  });
  if (
    isAbsolute(reference) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(reference) ||
    reference.includes('\\') ||
    reference.includes('\0')
  ) {
    return failure('path', 'must be a local relative path.');
  }
  const path = resolve(dirname(manifestPath), reference);
  if (!isPathContained(workspaceDir, path)) {
    return failure('escape', 'escapes the agent workspace.');
  }

  let canonicalPath: string;
  try {
    const [canonicalWorkspace, resolvedFile] = await Promise.all([
      realpath(workspaceDir),
      realpath(path),
    ]);
    if (!isPathContained(canonicalWorkspace, resolvedFile)) {
      return failure('escape', 'escapes the agent workspace through a symlink.', path);
    }
    canonicalPath = resolvedFile;
    if (!(await stat(canonicalPath)).isFile()) {
      return failure('not-regular', 'must name a regular file.', path);
    }
  } catch (error) {
    return failure(
      'unreadable',
      `could not be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`,
      path,
    );
  }

  let contents: Buffer;
  try {
    contents = await readFile(canonicalPath);
  } catch (error) {
    return failure(
      'unreadable',
      `could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`,
      path,
    );
  }
  if (contents.byteLength > maximumManifestBytes) {
    return failure('too-large', `exceeds the ${maximumManifestBytes}-byte size limit.`, path);
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    return failure('encoding', 'must be valid UTF-8.', path);
  }
  const fingerprint = createHash('sha256')
    .update(canonicalPath)
    .update('\0')
    .update(contents)
    .digest('hex');
  return { status: 'valid', path, fingerprint, contents, source };
}
