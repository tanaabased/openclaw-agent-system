import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import isPathContained from '../utils/is-path-contained.ts';
import nodeErrorCode from '../utils/node-error-code.ts';

/** Resolve a requested child directory and prove its canonical path stays in the workspace. */
export default async function resolveToolWorkingDirectory(
  workspaceDir: string,
  requestedDirectory = '.',
  admittedDirectories: readonly string[] = [],
): Promise<string> {
  const workspace = await realpath(workspaceDir);
  const candidate = await realpath(
    isAbsolute(requestedDirectory) ? requestedDirectory : resolve(workspace, requestedDirectory),
  );
  if (isPathContained(workspace, candidate)) return candidate;

  const admitted = await Promise.all(
    admittedDirectories.map(async (path) => {
      try {
        return await realpath(path);
      } catch (error) {
        if (nodeErrorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
    }),
  );
  if (admitted.some((root) => root && isPathContained(root, candidate))) {
    return candidate;
  }
  throw new Error('The requested tool working directory is outside its admitted roots.');
}
