import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { resolveToolExecutable } from '../../api/cli-runner.ts';
import isPathContained from '../../utils/is-path-contained.ts';

/** Resolve at invocation, not Install: operators may edit or upgrade a declared target. */
export default async function resolveDeclaredExecutable(
  executable: string,
  workspace: string,
  hostPath: string,
  hostExclusions: readonly string[],
  shimDirectories: readonly string[],
): Promise<string> {
  if (!executable.includes('/') || isAbsolute(executable)) {
    return resolveToolExecutable(
      executable,
      hostPath,
      isAbsolute(executable) ? shimDirectories : [...hostExclusions, ...shimDirectories],
    );
  }
  const root = await realpath(workspace);
  const path = resolve(root, executable);
  if (!isPathContained(root, path)) throw new Error('Executable escapes the bound workspace.');
  const target = await resolveToolExecutable(path, hostPath, shimDirectories);
  if (!isPathContained(root, target)) throw new Error('Executable escapes the bound workspace.');
  return target;
}
