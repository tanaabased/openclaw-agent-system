import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import isPathContained from '../utils/is-path-contained.ts';
import readBoundedManifestBytes, { maximumManifestBytes } from './read-bytes.ts';
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
  } catch (error) {
    return failure(
      'unreadable',
      `could not be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`,
      path,
    );
  }

  let contents: Buffer;
  try {
    const file = await readBoundedManifestBytes(canonicalPath);
    if (file.status === 'not-regular')
      return failure('not-regular', 'must name a regular file.', path);
    if (file.status === 'too-large')
      return failure('too-large', `exceeds the ${maximumManifestBytes}-byte size limit.`, path);
    contents = file.contents;
  } catch (error) {
    return failure(
      'unreadable',
      `could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`,
      path,
    );
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
