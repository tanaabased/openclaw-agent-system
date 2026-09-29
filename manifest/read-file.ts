import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { maximumManifestBytes } from './discover.ts';
import type { ManifestDiagnostic } from './types.ts';

export interface ManifestFileDependency {
  path: string;
  fingerprint: string;
}

function fileDiagnostic(
  code: string,
  reference: string,
  detail: string,
  fieldPath: string,
): ManifestDiagnostic {
  return {
    code,
    fieldPath: `${fieldPath}/file`,
    message: `Referenced file ${JSON.stringify(reference)} ${detail}`,
    severity: 'error',
  };
}
function withinWorkspace(workspace: string, path: string): boolean {
  const remainder = relative(workspace, path);
  return remainder !== '..' && !remainder.startsWith('../') && !isAbsolute(remainder);
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
  if (
    isAbsolute(reference) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(reference) ||
    reference.includes('\\') ||
    reference.includes('\0')
  ) {
    return {
      status: 'invalid',
      diagnostics: [
        fileDiagnostic(
          `${codePrefix}-path`,
          reference,
          'must be a local relative path.',
          fieldPath,
        ),
      ],
    };
  }
  const path = resolve(dirname(manifestPath), reference);
  if (!withinWorkspace(workspaceDir, path)) {
    return {
      status: 'invalid',
      diagnostics: [
        fileDiagnostic(
          `${codePrefix}-escape`,
          reference,
          'escapes the agent workspace.',
          fieldPath,
        ),
      ],
    };
  }

  let canonicalPath: string;
  try {
    const [canonicalWorkspace, resolvedFile] = await Promise.all([
      realpath(workspaceDir),
      realpath(path),
    ]);
    if (!withinWorkspace(canonicalWorkspace, resolvedFile)) {
      return {
        status: 'invalid',
        path,
        diagnostics: [
          fileDiagnostic(
            `${codePrefix}-escape`,
            reference,
            'escapes the agent workspace through a symlink.',
            fieldPath,
          ),
        ],
      };
    }
    canonicalPath = resolvedFile;
    if (!(await stat(canonicalPath)).isFile()) {
      return {
        status: 'invalid',
        path,
        diagnostics: [
          fileDiagnostic(
            `${codePrefix}-not-regular`,
            reference,
            'must name a regular file.',
            fieldPath,
          ),
        ],
      };
    }
  } catch (error) {
    return {
      status: 'invalid',
      path,
      diagnostics: [
        fileDiagnostic(
          `${codePrefix}-unreadable`,
          reference,
          `could not be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`,
          fieldPath,
        ),
      ],
    };
  }

  let contents: Buffer;
  try {
    contents = await readFile(canonicalPath);
  } catch (error) {
    return {
      status: 'invalid',
      path,
      diagnostics: [
        fileDiagnostic(
          `${codePrefix}-unreadable`,
          reference,
          `could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`,
          fieldPath,
        ),
      ],
    };
  }
  if (contents.byteLength > maximumManifestBytes) {
    return {
      status: 'invalid',
      path,
      diagnostics: [
        fileDiagnostic(
          `${codePrefix}-too-large`,
          reference,
          `exceeds the ${maximumManifestBytes}-byte size limit.`,
          fieldPath,
        ),
      ],
    };
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    return {
      status: 'invalid',
      path,
      diagnostics: [
        fileDiagnostic(`${codePrefix}-encoding`, reference, 'must be valid UTF-8.', fieldPath),
      ],
    };
  }
  const fingerprint = createHash('sha256')
    .update(canonicalPath)
    .update('\0')
    .update(contents)
    .digest('hex');
  return { status: 'valid', path, fingerprint, contents, source };
}
