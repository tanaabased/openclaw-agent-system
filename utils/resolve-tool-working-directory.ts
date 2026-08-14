import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import isPathContained from './is-path-contained.ts';

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
  const admitted = await Promise.all(admittedDirectories.map((path) => realpath(path)));
  if (![workspace, ...admitted].some((root) => isPathContained(root, candidate))) {
    throw new Error('The requested tool working directory is outside its admitted roots.');
  }
  return candidate;
}

/** Check lexical containment before resolving a command caller's current directory. */
export function isToolWorkingDirectoryContained(workspaceDir: string, candidate: string): boolean {
  return isPathContained(resolve(workspaceDir), resolve(candidate));
}
