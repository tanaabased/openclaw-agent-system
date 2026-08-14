import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import isPathContained from '../../utils/is-path-contained.ts';

/** Resolve one public trust file without admitting path or symlink escapes. */
export default function resolveGitAllowedSignersFile(
  declaredPath: string,
  workspaceDir: string,
): string {
  if (!declaredPath.trim() || isAbsolute(declaredPath) || declaredPath.startsWith('~')) {
    throw new Error('The allowed signers file must be workspace-relative.');
  }
  const workspace = realpathSync(workspaceDir);
  const requested = resolve(workspace, declaredPath);
  if (!isPathContained(workspace, requested)) {
    throw new Error('The allowed signers file escapes the workspace.');
  }
  const requestedStats = lstatSync(requested);
  if (!requestedStats.isFile() || requestedStats.isSymbolicLink()) {
    throw new Error('The allowed signers file must be a regular non-symlinked file.');
  }
  const canonical = realpathSync(requested);
  if (!isPathContained(workspace, canonical)) {
    throw new Error('The allowed signers file escapes the workspace through a symlink.');
  }
  return canonical;
}
