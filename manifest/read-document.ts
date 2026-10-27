import { parseManifestYaml } from './parse.ts';
import readBoundedManifestBytes, { maximumManifestBytes } from './read-bytes.ts';
import type { ManifestDiagnostic } from './types.ts';

export { maximumManifestBytes } from './read-bytes.ts';

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
    const file = await readBoundedManifestBytes(path);
    if (file.status === 'not-regular')
      return failure('manifest-not-regular-file', 'The manifest must be a regular file.');
    if (file.status === 'too-large')
      return failure(
        'manifest-too-large',
        `The manifest exceeds the ${maximumManifestBytes}-byte size limit.`,
      );
    return { status: 'valid', path, contents: file.contents };
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
