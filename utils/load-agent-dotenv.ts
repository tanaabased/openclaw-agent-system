import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { ManifestDiagnostic } from './manifest-types.ts';
import parseDotenv from './parse-dotenv.ts';
import type { AgentEnvironmentInputSource } from './resolve-agent-environment.ts';

export const maximumDotenvBytes = 1024 * 1024;

export type AgentDotenvLoadResult =
  | {
      status: 'invalid';
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'loaded';
      sources: AgentEnvironmentInputSource[];
    };

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function diagnostic(code: string, message: string, index: number): ManifestDiagnostic {
  return {
    code,
    fieldPath: `/environment/dotenv/${index}`,
    message,
    severity: 'error',
  };
}

/** Load declared dotenv files from one canonical workspace without following escapes. */
export default async function loadAgentDotenv(
  workspaceDir: string,
  declaredPaths: readonly string[],
): Promise<AgentDotenvLoadResult> {
  if (declaredPaths.length === 0) return { status: 'loaded', sources: [] };

  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(workspaceDir);
  } catch {
    return {
      status: 'invalid',
      diagnostics: [
        diagnostic(
          'dotenv-workspace-unreadable',
          'The workspace containing the declared dotenv files could not be resolved.',
          0,
        ),
      ],
    };
  }

  const normalizedWorkspace = resolve(workspaceDir);
  const canonicalPaths = new Set<string>();
  const diagnostics: ManifestDiagnostic[] = [];
  const sources: AgentEnvironmentInputSource[] = [];

  for (const [index, declaredPath] of declaredPaths.entries()) {
    if (isAbsolute(declaredPath)) {
      diagnostics.push(
        diagnostic(
          'dotenv-path-absolute',
          'Dotenv paths must be relative to the agent workspace.',
          index,
        ),
      );
      continue;
    }

    const candidatePath = resolve(normalizedWorkspace, declaredPath);
    if (!isWithin(normalizedWorkspace, candidatePath)) {
      diagnostics.push(
        diagnostic(
          'dotenv-path-outside-workspace',
          'The dotenv path resolves outside the agent workspace.',
          index,
        ),
      );
      continue;
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(candidatePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      diagnostics.push(
        diagnostic(
          code === 'ENOENT' ? 'dotenv-file-missing' : 'dotenv-file-unreadable',
          code === 'ENOENT'
            ? 'A declared dotenv file does not exist.'
            : 'A declared dotenv file could not be resolved.',
          index,
        ),
      );
      continue;
    }

    if (!isWithin(canonicalWorkspace, canonicalPath)) {
      diagnostics.push(
        diagnostic(
          'dotenv-path-outside-workspace',
          'The dotenv path resolves outside the agent workspace.',
          index,
        ),
      );
      continue;
    }
    if (canonicalPaths.has(canonicalPath)) {
      diagnostics.push(
        diagnostic(
          'dotenv-path-duplicate',
          'Dotenv paths must not resolve to the same file more than once.',
          index,
        ),
      );
      continue;
    }
    canonicalPaths.add(canonicalPath);

    let fileStats;
    try {
      fileStats = await stat(canonicalPath);
    } catch {
      diagnostics.push(
        diagnostic(
          'dotenv-file-unreadable',
          'A declared dotenv file could not be inspected.',
          index,
        ),
      );
      continue;
    }
    if (!fileStats.isFile()) {
      diagnostics.push(
        diagnostic(
          'dotenv-not-regular-file',
          'A dotenv path must resolve to a regular file.',
          index,
        ),
      );
      continue;
    }
    if (fileStats.size > maximumDotenvBytes) {
      diagnostics.push(
        diagnostic(
          'dotenv-file-too-large',
          `A dotenv file exceeds the ${maximumDotenvBytes}-byte size limit.`,
          index,
        ),
      );
      continue;
    }

    let contents: Buffer;
    try {
      contents = await readFile(canonicalPath);
    } catch {
      diagnostics.push(
        diagnostic('dotenv-file-unreadable', 'A declared dotenv file could not be read.', index),
      );
      continue;
    }
    if (contents.byteLength > maximumDotenvBytes) {
      diagnostics.push(
        diagnostic(
          'dotenv-file-too-large',
          `A dotenv file exceeds the ${maximumDotenvBytes}-byte size limit.`,
          index,
        ),
      );
      continue;
    }

    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    } catch {
      diagnostics.push(
        diagnostic('dotenv-encoding', 'Dotenv files must contain valid UTF-8.', index),
      );
      continue;
    }

    const parsed = parseDotenv(source);
    if (parsed.status === 'invalid') {
      diagnostics.push(
        ...parsed.diagnostics.map(({ code, line, message }) =>
          diagnostic(code, `Dotenv line ${line}: ${message}`, index),
        ),
      );
      continue;
    }
    sources.push({ source: `environment.dotenv[${index}]`, values: parsed.values });
  }

  if (diagnostics.length > 0) return { status: 'invalid', diagnostics };
  return { status: 'loaded', sources };
}
