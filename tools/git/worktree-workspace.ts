import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { GitWorktreeConfiguration } from './config-schema.ts';
import resolveGitWorktreeLayout from './worktree-layout.ts';
import isPathContained from '../../utils/is-path-contained.ts';

async function readMarker(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('worktree-marker-not-regular');
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 4096) throw new Error('worktree-marker-too-large');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)).trim();
    if (!text || /[\0\r\n]/u.test(text)) throw new Error('worktree-marker-invalid');
    return text;
  } finally {
    await file.close();
  }
}

/** verify linked-worktree metadata inside this agent's managed bare-repository layout.
 * this binds execution location, not issue admission or permission to publish.
 */
export default async function isManagedWorktreeWorkspace(
  workspace: string,
  configuration: GitWorktreeConfiguration | undefined,
  directory: string,
): Promise<boolean> {
  if (!configuration || !isAbsolute(directory)) return false;
  try {
    const layout = resolveGitWorktreeLayout(workspace, configuration);
    const cwd = resolve(directory);
    if (
      cwd === layout.worktreeRoot ||
      !isPathContained(layout.worktreeRoot, cwd) ||
      dirname(dirname(cwd)) !== layout.worktreeRoot
    )
      return false;
    // reject aliases before reading any repository-owned marker.
    for (const path of [layout.workspaceDir, layout.worktreeRoot, layout.repositoryRoot, cwd])
      if ((await realpath(path)) !== path) return false;
    const marker = await readMarker(join(cwd, '.git'));
    if (!marker.startsWith('gitdir: ')) return false;
    const admin = resolve(cwd, marker.slice(8));
    const repository = dirname(dirname(admin));
    if (
      dirname(admin) !== join(repository, 'worktrees') ||
      dirname(repository) !== layout.repositoryRoot ||
      basename(repository) !== `${basename(dirname(cwd))}.git` ||
      (await realpath(admin)) !== admin ||
      (await realpath(repository)) !== repository
    )
      return false;
    const common = resolve(admin, await readMarker(join(admin, 'commondir')));
    const backlink = resolve(admin, await readMarker(join(admin, 'gitdir')));
    return common === repository && backlink === join(cwd, '.git');
  } catch {
    return false;
  }
}
