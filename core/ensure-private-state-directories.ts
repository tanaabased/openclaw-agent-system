import { type Stats } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';

import nodeErrorCode from '../utils/node-error-code.ts';

export interface EnsurePrivateStateDirectoriesOptions {
  currentUid?: number;
  directories: string[];
  label: string;
}

function assertPrivateDirectory(
  stats: Stats,
  options: Pick<EnsurePrivateStateDirectoriesOptions, 'currentUid' | 'label'>,
): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${options.label} directories must be real directories.`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${options.label} directories must be private.`);
  }
  if (options.currentUid !== undefined && stats.uid !== options.currentUid) {
    throw new Error(`${options.label} directories must be owned by the current user.`);
  }
}

/** Create and verify one private directory chain without following final symlinks. */
export default async function ensurePrivateStateDirectories(
  options: EnsurePrivateStateDirectoriesOptions,
): Promise<void> {
  for (const [index, directory] of options.directories.entries()) {
    try {
      await mkdir(directory, { mode: 0o700, recursive: index === 0 });
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error;
    }
    assertPrivateDirectory(await lstat(directory), options);
  }
}
