import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { parseManifestYaml } from './parse.ts';
import type { ManifestDiagnostic } from './types.ts';

export const maximumManifestBytes = 1024 * 1024;

/** read bounded bytes without following a file symlink, including during cache inspection. */
export async function readManifestBytes(
  path: string,
): Promise<
  | { status: 'valid'; path: string; contents: Buffer }
  | { status: 'invalid'; diagnostics: ManifestDiagnostic[] }
> {
  const failure = (code: string, message: string) => ({
    status: 'invalid' as const,
    diagnostics: [{ code, message, severity: 'error' as const, sourcePath: path }],
  });
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await file.stat();
      if (!stats.isFile())
        return failure('manifest-not-regular-file', 'The manifest must be a regular file.');
      // a bounded read also covers a file growing after discovery.
      const buffer = Buffer.alloc(maximumManifestBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maximumManifestBytes)
        return failure(
          'manifest-too-large',
          `The manifest exceeds the ${maximumManifestBytes}-byte size limit.`,
        );
      const contents = buffer.subarray(0, size);
      return { status: 'valid', path, contents };
    } finally {
      await file.close();
    }
  } catch {
    return failure('manifest-load-failed', 'The manifest could not be read safely.');
  }
}

/** parse one bounded manifest document before merging or resolving external references. */
export default async function readManifestDocument(
  path: string,
): Promise<
  | { status: 'valid'; path: string; contents: Buffer; value: unknown }
  | { status: 'invalid'; diagnostics: ManifestDiagnostic[] }
> {
  const file = await readManifestBytes(path);
  if (file.status === 'invalid') return file;
  const failure = (code: string, message: string) => ({
    status: 'invalid' as const,
    diagnostics: [{ code, message, severity: 'error' as const, sourcePath: path }],
  });
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(file.contents);
  } catch {
    return failure('manifest-encoding', 'The manifest must be valid UTF-8.');
  }
  const parsed = parseManifestYaml(source);
  if (parsed.status === 'invalid')
    return {
      status: 'invalid',
      diagnostics: parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, sourcePath: path })),
    };
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value))
    return failure('manifest-schema', 'The manifest document must be a mapping.');
  return { ...file, value: parsed.value };
}
